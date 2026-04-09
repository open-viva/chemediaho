"""
=============================================================================
LOCAL-ONLY BACKEND - DO NOT DEPLOY TO CLOUD SERVICES
=============================================================================
This backend MUST run locally on a residential IP address.

It is designed to bypass Akamai WAF blocking when calling web.spaggiari.eu,
which requires outbound requests to originate from a residential IP.

DO NOT DEPLOY THIS BACKEND TO:
- Vercel, Netlify, or any other serverless platform
- Fly.io, Railway, Render, or any other cloud hosting provider
- AWS Lambda, Google Cloud Functions, Azure Functions, etc.

The frontend should be deployed to Vercel and connect to this local backend
via an HTTPS tunnel (ngrok, Cloudflare Tunnel, etc.).

This setup ensures:
- Outbound requests to web.spaggiari.eu come from your residential IP
- The frontend can safely call the backend over HTTPS
- Akamai WAF is bypassed for scraping operations
=============================================================================
"""

import requests
import json
import flask
import os
import secrets
import csv
import io
import logging
from datetime import datetime
from flask_cors import CORS

# -----------------------------------------------------------------------------
# Standalone Mode (Docker all-in-one)
# -----------------------------------------------------------------------------
# When STANDALONE_MODE=true, the Flask app serves both the API and the static
# frontend files. This is the recommended mode for Docker deployments.
#
# When STANDALONE_MODE=false, the Flask app works as a thin proxy towards
# openviva api: https://github.com/open-viva/api
# -----------------------------------------------------------------------------
STANDALONE_MODE = os.environ.get('STANDALONE_MODE', 'true').lower() == 'true'

if STANDALONE_MODE:
    app = flask.Flask(__name__, static_folder='frontend', static_url_path='')
else:
    app = flask.Flask(__name__)

# -----------------------------------------------------------------------------
# CORS Configuration for Vercel Frontend
# -----------------------------------------------------------------------------
# Allow requests from Vercel preview/production domains and localhost for dev.
# Credentials (cookies/session) are enabled for cross-origin session handling.
#
# NOTE: The regex pattern allows any *.vercel.app subdomain. This is intentional
# because Vercel preview deployments get random subdomains.
# -----------------------------------------------------------------------------
CORS(app,
     origins=[
         r"https://.*\.vercel\.app",  # Vercel preview and production domains
         "http://localhost:3000"       # Local frontend development
     ],
     supports_credentials=True,        # Allow cookies/session across origins
     allow_headers=["Content-Type", "X-API-Key"],  # Allow custom headers
     expose_headers=["Content-Type"])

# -----------------------------------------------------------------------------
# API Key Protection
# -----------------------------------------------------------------------------
# All routes require a valid X-API-Key header, except for:
# - / (home page)
# - /manifest.json (PWA manifest)
# - /sw.js (service worker)
# - /static/* (static files)
#
# The API key is read from the API_KEY environment variable.
# -----------------------------------------------------------------------------
API_KEY = os.environ.get('API_KEY', '').strip() or None  # Treat empty string as None

# Routes that do NOT require API key authentication in standalone mode.
# /api/login is intentionally excluded: when API_KEY is configured we keep a
# shared-key gate even on auth bootstrap endpoints.
PUBLIC_ROUTES = frozenset(['/api/version'])
PROXIED_ROUTES = frozenset([
    '/api/version',
    '/api/login',
    '/login',
    '/logout',
    '/grades',
    '/export',
    '/settings',
    '/overall_average_detail',
    '/set_blue_grade_preference',
    '/calculate_goal',
    '/predict_average',
    '/calculate_goal_overall',
    '/predict_average_overall',
    '/export/csv'
])
PROXY_PATH_MAP = {
    '/login': '/api/login',
    '/grades': '/api/grades',
    '/api/version': '/api/health',
}
API_BASE = os.environ.get('API_BASE', '').strip().rstrip('/')


def proxy_to_upstream():
    """Forward proxied API requests (GET/POST/OPTIONS, etc.) to API_BASE.
    
    Returns:
    - 503 when API_BASE is missing
    - 502 when upstream is unreachable or returns an unexpected content type
    - Upstream status/body/headers for expected API responses
    """
    if not API_BASE:
        return flask.jsonify({'error': 'API_BASE non configurato'}), 503

    upstream_path = PROXY_PATH_MAP.get(flask.request.path, flask.request.path)
    upstream_url = f"{API_BASE}{upstream_path}"
    forwarded_headers = {
        key: value
        for key, value in flask.request.headers.items()
        if key.lower() not in {'host', 'content-length', 'connection'}
    }

    try:
        upstream_response = requests.request(
            method=flask.request.method,
            url=upstream_url,
            params=flask.request.args,
            data=flask.request.get_data(),
            headers=forwarded_headers,
            cookies=flask.request.cookies,
            allow_redirects=False,
            timeout=30
        )
    except requests.exceptions.RequestException as exc:
        logger.warning("OpenViva API request failed: %s", exc)
        return flask.jsonify({'error': 'Impossibile raggiungere openviva api'}), 502

    content_type = upstream_response.headers.get('Content-Type', '')
    allowed_response = (
        content_type.startswith('application/json')
        or content_type.startswith('text/csv')
    )
    if not allowed_response:
        logger.warning("Unexpected OpenViva API content type for %s: %s", flask.request.path, content_type)
        return flask.jsonify({'error': 'Risposta openviva api non valida'}), 502

    if content_type.startswith('application/json'):
        try:
            payload = upstream_response.json()
        except ValueError:
            logger.warning("Invalid JSON returned by OpenViva API for %s", flask.request.path)
            return flask.jsonify({'error': 'Risposta openviva api non valida'}), 502
        # Keep the existing /api/version contract while sourcing the value from
        # openviva api /api/health response.
        if flask.request.path == '/api/version':
            version = payload.get('version')
            if not version:
                logger.warning("Missing version field in OpenViva API health response")
                return flask.jsonify({'error': 'Campo version mancante nella risposta /api/health di openviva api'}), 502
            payload = {'version': version}
        response = flask.jsonify(payload)
        response.status_code = upstream_response.status_code
        return response

    try:
        csv_content = upstream_response.content.decode('utf-8')
    except UnicodeDecodeError:
        logger.warning("Invalid UTF-8 in OpenViva API CSV response for %s", flask.request.path)
        csv_content = upstream_response.content.decode('utf-8', errors='replace')
    response = flask.Response(csv_content, mimetype='text/csv')
    response.status_code = upstream_response.status_code
    response.headers['Content-Disposition'] = 'attachment; filename=voti.csv'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    return response


@app.before_request
def check_api_key():
    """
    Middleware to validate API key for protected routes.
    
    Returns 401 Unauthorized if:
    - API_KEY environment variable is set AND
    - The route is not in PUBLIC_ROUTES AND
    - The route does not start with /static/ AND
    - The X-API-Key header is missing or does not match
    """
    # In proxy mode, forward configured API routes to the external endpoint.
    # /subject_detail/<subject_name> is a dynamic route and is matched by prefix.
    if not STANDALONE_MODE and (
        flask.request.path in PROXIED_ROUTES
        or flask.request.path.startswith('/subject_detail/')
    ):
        if API_KEY and flask.request.method != 'OPTIONS':
            provided_key = flask.request.headers.get('X-API-Key')
            if not provided_key or not secrets.compare_digest(provided_key, API_KEY):
                return flask.jsonify({'error': 'Unauthorized: Invalid or missing API key'}), 401
        return proxy_to_upstream()

    # Skip API key check if no API_KEY is configured (development mode)
    if not API_KEY:
        return None
    
    # Allow CORS preflight requests (OPTIONS) without API key
    # This is required for browsers to complete the CORS handshake
    if flask.request.method == 'OPTIONS':
        return None
    
    # Allow public routes without API key
    if flask.request.path in PUBLIC_ROUTES:
        return None
    
    # Allow static files without API key
    if flask.request.path.startswith('/static/'):
        return None
    
    # Validate API key for all other routes
    provided_key = flask.request.headers.get('X-API-Key')
    if not provided_key or not secrets.compare_digest(provided_key, API_KEY):
        return flask.jsonify({'error': 'Unauthorized: Invalid or missing API key'}), 401
    
    return None

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Application version
APP_VERSION = "2.5.0"

# Constants for grade calculations
GRADE_ROUNDING_THRESHOLD = 9.5  # Grades >= 9.5 can be rounded to 10
DEFAULT_INCLUDE_BLUE_GRADES = False  # Default: don't include blue grades

# Constants for intelligent subject suggestions
# SUGGESTION_IMPACT_WEIGHT: Balances difficulty vs. impact in scoring
#   - Lower values (e.g., 0.05) prioritize subjects with lower current averages
#   - Higher values (e.g., 0.2) prioritize subjects with fewer grades (higher impact per grade)
#   - 0.1 provides a good balance between both factors
SUGGESTION_IMPACT_WEIGHT = 0.1
# MAX_SUGGESTIONS: Number of subject suggestions to return
#   - 4 provides enough variety without overwhelming the user
#   - First suggestion is the "optimal" one, others are alternatives
MAX_SUGGESTIONS = 4

# Allowed grade values for smart calculator
ALLOWED_GRADES = [4, 4.25, 4.5, 4.75, 5, 5.25, 5.5, 5.75, 6, 6.25, 6.5, 6.75, 7, 7.25, 7.5, 7.75, 8, 8.25, 8.5, 8.75, 9, 9.25, 9.5, 9.75, 10]

# Mark table: maps display grade notation to decimal values
# Used for both HTML scraping and as fallback when API decimalValue is missing
MARK_TABLE = {
    "1": 1, "1+": 1.25, "1½": 1.5, "2-": 1.75, "2": 2, "2+": 2.25, "2½": 2.5,
    "3-": 2.75, "3": 3, "3+": 3.25, "3½": 3.5, "4-": 3.75, "4": 4, "4+": 4.25,
    "4½": 4.5, "5-": 4.75, "5": 5, "5+": 5.25, "5½": 5.5, "6-": 5.75, "6": 6,
    "6+": 6.25, "6½": 6.5, "7-": 6.75, "7": 7, "7+": 7.25, "7½": 7.5, "8-": 7.75,
    "8": 8, "8+": 8.25, "8½": 8.5, "9-": 8.75, "9": 9, "9+": 9.25, "9½": 9.5,
    "10-": 9.75, "10": 10
}

# Load or generate a persistent SECRET_KEY
SECRET_KEY_FILE = 'secret_key.txt'

def get_secret_key():
    """Load secret key from file, or generate and save a new one if it doesn't exist."""
    # First priority: environment variable (for production with external secret management)
    if os.environ.get('SECRET_KEY'):
        return os.environ.get('SECRET_KEY')
    
    # Second priority: load from file (for persistence across restarts)
    if os.path.exists(SECRET_KEY_FILE):
        try:
            with open(SECRET_KEY_FILE, 'r') as f:
                return f.read().strip()
        except Exception as e:
            print(f"Warning: Could not read secret key file: {e}")
    
    # Last resort: generate a new key and save it
    new_key = secrets.token_hex(32)
    try:
        # Create file with restricted permissions (owner read/write only)
        # Using os.open with specific flags for secure file creation
        fd = os.open(SECRET_KEY_FILE, os.O_CREAT | os.O_WRONLY | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as f:
            f.write(new_key)
        print(f"Generated new secret key and saved to {SECRET_KEY_FILE}")
    except FileExistsError:
        # File was created between the exists check and open - try reading it
        with open(SECRET_KEY_FILE, 'r') as f:
            return f.read().strip()
    except Exception as e:
        print(f"Warning: Could not save secret key to file: {e}")
    
    return new_key

app.secret_key = get_secret_key()

# -----------------------------------------------------------------------------
# Session Cookie Configuration for HTTPS Tunnel Usage
# -----------------------------------------------------------------------------
# When running behind an HTTPS tunnel (ngrok, Cloudflare Tunnel), session
# cookies must be configured for cross-origin usage
# To run with HTTPS tunnel:
#   HTTPS_ENABLED=true API_KEY=your-key python app.py
# -----------------------------------------------------------------------------
_https_enabled = os.environ.get('HTTPS_ENABLED', 'false').lower() == 'true'

# Log cookie configuration at startup for debugging
logger.info(f"Session cookie config: HTTPS_ENABLED={_https_enabled}, SameSite={'None' if _https_enabled else 'Lax'}")
if not _https_enabled:
    logger.warning("HTTPS_ENABLED is not set! Cross-origin requests will NOT receive session cookies.")
    logger.warning("If using a frontend on a different origin (e.g., Vercel, localhost:3000), set HTTPS_ENABLED=true and use an HTTPS tunnel.")

app.config.update(
    SESSION_COOKIE_SECURE=_https_enabled,        # Secure cookies over HTTPS tunnel
    SESSION_COOKIE_HTTPONLY=True,                # Prevent JavaScript access (XSS protection)
    SESSION_COOKIE_SAMESITE='None' if _https_enabled else 'Lax'  # Cross-origin for HTTPS tunnel
)

# =============================================================================
# STANDALONE MODE: Serve static frontend files
# =============================================================================
# When STANDALONE_MODE=true, the Flask app serves the frontend as static files.
# This enables "all-in-one" Docker deployment without a separate frontend server.
# =============================================================================

if STANDALONE_MODE:
    logger.info("Running in STANDALONE mode - serving frontend files from /frontend")
    
    @app.route('/')
    def serve_index():
        """Serve the main login page"""
        return flask.send_from_directory('frontend', 'index.html')
    
    @app.route('/grades.html')
    def serve_grades():
        """Serve the grades page"""
        return flask.send_from_directory('frontend', 'grades.html')
    
    @app.route('/export.html')
    def serve_export():
        """Serve the export page"""
        return flask.send_from_directory('frontend', 'export.html')
    
    @app.route('/settings.html')
    def serve_settings():
        """Serve the settings page"""
        return flask.send_from_directory('frontend', 'settings.html')
    
    @app.route('/subject_detail.html')
    def serve_subject_detail():
        """Serve the subject detail page"""
        return flask.send_from_directory('frontend', 'subject_detail.html')
    
    @app.route('/overall_average_detail.html')
    def serve_overall_average_detail():
        """Serve the overall average detail page"""
        return flask.send_from_directory('frontend', 'overall_average_detail.html')
    
    @app.route('/manifest.json')
    def serve_manifest():
        """Serve PWA manifest"""
        return flask.send_from_directory('frontend', 'manifest.json')
    
    @app.route('/sw.js')
    def serve_sw():
        """Serve service worker"""
        return flask.send_from_directory('frontend', 'sw.js')
else:
    logger.info(
        "Running in PROXY mode - API calls are forwarded to API_BASE (%s)",
        API_BASE if API_BASE else "missing"
    )

# =============================================================================
# API ENDPOINTS
# =============================================================================
# JSON-only responses. No HTML rendering.
# The frontend is either served by Flask (standalone) or deployed separately.
# =============================================================================

@app.route('/api/version')
def api_version():
    """Return API version info"""
    return flask.jsonify({'version': APP_VERSION}), 200

# /api/login is the canonical endpoint for openviva api integration.
# /login is kept as a backward-compatible alias.
@app.route('/api/login', methods=['POST'])
@app.route('/login', methods=['POST'])
def login_route():
    """
    API endpoint for login - returns JSON response.
    POST /api/login (canonical) or /login (alias) with form data: user_id, user_pass
    Returns: { success: true } or { error: "..." }
    """
    user_id = flask.request.form.get('user_id', '')
    user_pass = flask.request.form.get('user_pass', '')
    
    # Log session cookie configuration for debugging
    logger.info(f"Session cookie config: Secure={app.config.get('SESSION_COOKIE_SECURE')}, SameSite={app.config.get('SESSION_COOKIE_SAMESITE')}")
    logger.info(f"HTTPS_ENABLED={os.environ.get('HTTPS_ENABLED', 'false')}")
    
    try:
        login_response = login(user_id, user_pass)
        token = login_response["token"]
        if token is None or token == "":
            return flask.jsonify({'success': False, 'error': 'Token non valido. Riprova.'}), 401

        # Store token and user_id in session
        flask.session['token'] = token
        flask.session['user_id'] = user_id

        student_id = "".join(filter(str.isdigit, user_id))
        grades_avr = calculate_avr(get_grades(student_id, token))

        # Store grades in session for other pages
        flask.session['grades_avr'] = grades_avr

        # Log session initialization (avoid logging sensitive data)
        logger.info(f"Login success - Session initialized with {len(flask.session)} keys")

        return flask.jsonify({'success': True}), 200
    except requests.exceptions.HTTPError as e:
        # Handle 422 and other HTTP errors with user-friendly message
        error_code = getattr(e.response, 'status_code', None) if hasattr(e, 'response') else None
        if error_code == 422:
            return flask.jsonify({'success': False, 'error': 'Credenziali non valide. Verifica le tue credenziali.'}), 401
        else:
            return flask.jsonify({'success': False, 'error': 'Errore di autenticazione. Riprova.'}), 500
    except requests.exceptions.RequestException as e:
        return flask.jsonify({'success': False, 'error': 'Errore di connessione. Verifica la tua connessione internet.'}), 500
    except Exception as e:
        logger.error(f"Login error: {e}", exc_info=True)
        return flask.jsonify({'success': False, 'error': 'Errore imprevisto. Riprova più tardi.'}), 500

@app.route('/logout', methods=['POST'])
def logout():
    """API endpoint for logout - returns JSON response."""
    flask.session.clear()
    return flask.jsonify({'success': True}), 200

@app.route('/grades')
def grades_page():
    """API endpoint for grades - returns JSON data."""
    # debug logging (without sensitive data)
    cookie_present = bool(flask.request.headers.get('Cookie'))
    session_count = len(flask.session)
    has_grades = 'grades_avr' in flask.session
    
    logger.info(f"Grades request - Session has {session_count} keys, has_grades={has_grades}, cookie_present={cookie_present}")
    
    if not has_grades:
        # debug errors
        if not cookie_present:
            logger.warning("No Cookie header in request - likely a cross-origin issue. Set HTTPS_ENABLED=true and use an HTTPS tunnel.")
            return flask.jsonify({
                'error': 'No active session',
                'authenticated': False,
                'debug': {
                    'cookie_received': False,
                    'hint': 'If using cross-origin (different domain/port), set HTTPS_ENABLED=true and use an HTTPS tunnel'
                }
            }), 401
        return flask.jsonify({'error': 'No active session', 'authenticated': False}), 401
    
    grades_avr = flask.session['grades_avr']
    return flask.jsonify(grades_avr), 200

@app.route('/export')
def export_page():
    """API endpoint for export check - returns JSON status."""
    if 'token' not in flask.session:
        return flask.jsonify({'error': 'No active session', 'authenticated': False}), 401
    
    return flask.jsonify({'authenticated': True}), 200

@app.route('/settings')
def settings_page():
    """API endpoint for settings - returns JSON data."""
    return flask.jsonify({'version': APP_VERSION}), 200

@app.route('/overall_average_detail')
def overall_average_detail_page():
    """API endpoint for overall average detail - returns JSON data."""
    if 'grades_avr' not in flask.session:
        return flask.jsonify({'error': 'No active session', 'authenticated': False}), 401
    
    grades_avr = flask.session['grades_avr']
    return flask.jsonify(grades_avr), 200

@app.route('/subject_detail/<subject_name>')
def subject_detail_page(subject_name):
    """API endpoint for subject detail - returns JSON data."""
    if 'grades_avr' not in flask.session:
        return flask.jsonify({'error': 'No active session', 'authenticated': False}), 401
    
    grades_avr = flask.session['grades_avr']
    
    subject_found = False
    for period in grades_avr:
        if period != 'all_avr' and subject_name in grades_avr[period]:
            subject_found = True
            break
    
    if not subject_found:
        return flask.jsonify({'error': 'Subject not found'}), 404
    
    return flask.jsonify({'grades_avr': grades_avr, 'subject_name': subject_name}), 200

@app.route('/set_blue_grade_preference', methods=['POST'])
def set_blue_grade_preference():
    """Set the user's preference for including/excluding blue grades in calculations"""
    try:
        data = flask.request.get_json()
        include_blue_grades = data.get('include_blue_grades', True)
        
        # store preference
        flask.session['include_blue_grades'] = include_blue_grades
        
        # if we have grades, recalculate
        if 'grades_avr' in flask.session:
            grades_avr = flask.session['grades_avr']
            recalculate_averages(grades_avr, not include_blue_grades)
            flask.session['grades_avr'] = grades_avr
            flask.session.modified = True
        
        return flask.jsonify({'success': True, 'include_blue_grades': include_blue_grades}), 200
        
    except Exception as e:
        logger.error(f"Error setting blue grade preference: {e}", exc_info=True)
        return flask.jsonify({'error': 'Errore nel salvataggio della preferenza'}), 500

def recalculate_averages(grades_avr, exclude_blue=False):
    """Recalculate subject, period, and overall averages based on blue grade preference"""
    # recalculate subject averages
    for period in grades_avr:
        if period == 'all_avr':
            continue
        for subject in grades_avr[period]:
            if subject == 'period_avr':
                continue
            filtered_grades = [g for g in grades_avr[period][subject]['grades'] 
                           if not (exclude_blue and g.get('isBlue', False))]
            effective = _get_effective_grades(filtered_grades)
            grades_avr[period][subject]["avr"] = sum(effective) / len(effective) if effective else 0
    
    # recalculate period averages
    for period in grades_avr:
        if period == 'all_avr':
            continue
        period_grades = []
        for subject in grades_avr[period]:
            if subject == 'period_avr':
                continue
            filtered_grades = [g for g in grades_avr[period][subject]['grades']
                                if not (exclude_blue and g.get('isBlue', False))]
            period_grades.extend(_get_effective_grades(filtered_grades))
        grades_avr[period]["period_avr"] = sum(period_grades) / len(period_grades) if period_grades else 0
    
    # recalculate overall average
    all_grades = []
    for period in grades_avr:
        if period == 'all_avr':
            continue
        for subject in grades_avr[period]:
            if subject == 'period_avr':
                continue
            filtered_grades = [g for g in grades_avr[period][subject]['grades']
                             if not (exclude_blue and g.get('isBlue', False))]
            all_grades.extend(_get_effective_grades(filtered_grades))
    grades_avr["all_avr"] = sum(all_grades) / len(all_grades) if all_grades else 0

@app.route('/calculate_goal', methods=['POST'])
def calculate_goal():
    """Calculate what grade is needed to reach a target average in a specific period.
    If subject is not provided, returns intelligent suggestions for all subjects in the period."""
    if 'grades_avr' not in flask.session:
        return flask.jsonify({'error': 'No active session'}), 401
    
    try:
        data = flask.request.get_json()
        period = data.get('period')
        subject = data.get('subject')  # optional
        target_average = float(data.get('target_average'))
        num_grades = int(data.get('num_grades', 1))
        
        grades_avr = flask.session['grades_avr']
        
        if not period or period not in grades_avr:
            return flask.jsonify({'error': 'Periodo non trovato'}), 400
        
        if target_average < 1 or target_average > 10:
            return flask.jsonify({'error': 'La media target deve essere tra 1 e 10'}), 400
        
        if num_grades < 1 or num_grades > 10:
            return flask.jsonify({'error': 'Il numero di voti deve essere tra 1 e 10'}), 400
        
        # return intelligent suggestions if no subject
        if not subject:
            suggestions = calculate_period_subject_suggestions(grades_avr, period, target_average, num_grades)
            
            return flask.jsonify({
                'success': True,
                'period': period,
                'target_average': target_average,
                'suggestions': suggestions,
                'num_grades': num_grades,
                'message': get_period_suggestion_message(suggestions, target_average, num_grades, period)
            }), 200
        
        if subject not in grades_avr[period]:
            return flask.jsonify({'error': 'Materia non trovata nel periodo selezionato'}), 400
        
        # get current grades
        subject_data = grades_avr[period][subject]
        if 'grades' not in subject_data or not isinstance(subject_data['grades'], list):
            return flask.jsonify({'error': 'Dati dei voti non validi'}), 400
        
        # extract effective grades (component grades averaged per event)
        current_grades = _get_effective_grades(
            [g for g in subject_data['grades'] 
             if isinstance(g, dict) and 'decimalValue' in g and g['decimalValue'] is not None]
        )
        
        if not current_grades:
            return flask.jsonify({'error': 'Nessun voto disponibile per questa materia'}), 400
        
        current_count = len(current_grades)
        current_sum = sum(current_grades)
        current_average = subject_data.get('avr', current_sum / current_count if current_count > 0 else 0)
        
        # check if current grade already meets or exceed target
        if current_average >= target_average:
            return flask.jsonify({
                'success': True,
                'current_average': round(current_average, 2),
                'target_average': target_average,
                'required_grade': None,
                'required_grades': [],
                'current_grades_count': current_count,
                'achievable': True,
                'already_achieved': True,
                'subject': subject,
                'message': f"🎉 Obiettivo già raggiunto! La tua media attuale ({round(current_average, 2)}) è già pari o superiore all'obiettivo di {target_average}."
            }), 200
        
        # Calculate required grades
        # For multiple grades, we calculate the average grade needed
        # Formula: (current_sum + required_sum) / (current_count + num_grades) = target_average
        # required_sum = target_average * (current_count + num_grades) - current_sum
        required_sum = target_average * (current_count + num_grades) - current_sum
        required_average_grade = required_sum / num_grades
        
        # Round to nearest allowed grade
        display_grade = round_to_allowed_grade(required_average_grade)
        
        # Note: For simplicity and clarity, we assume all required grades are the same
        # This gives the student a single, clear target to aim for across all tests
        required_grades = [display_grade] * num_grades
        
        # Determine if it's achievable (use original value for comparison)
        # The goal is achievable if the required grade is within the allowed range
        achievable = required_average_grade <= max(ALLOWED_GRADES)
        
        return flask.jsonify({
            'success': True,
            'current_average': round(current_average, 2),
            'target_average': target_average,
            'required_grade': display_grade,
            'required_grades': required_grades,
            'current_grades_count': current_count,
            'achievable': achievable,
            'already_achieved': False,
            'subject': subject,
            'message': get_goal_message_multiple(required_average_grade, display_grade, target_average, current_average, num_grades)
        }), 200
        
    except ValueError as e:
        return flask.jsonify({'error': 'Valori non validi'}), 400
    except Exception as e:
        logger.error(f"Error calculating goal: {e}", exc_info=True)
        return flask.jsonify({'error': 'Errore durante il calcolo'}), 500

def round_to_allowed_grade(grade):
    """Round a grade to the nearest allowed value"""
    if grade < min(ALLOWED_GRADES):
        return min(ALLOWED_GRADES)
    if grade > max(ALLOWED_GRADES):
        return max(ALLOWED_GRADES)
    
    closest = min(ALLOWED_GRADES, key=lambda x: abs(x - grade))
    return closest

def get_goal_message_multiple(raw_grade, display_grade, target_average, current_average, num_grades):
    """Generate a helpful message based on the calculation result for multiple grades"""
    grade_text = "un voto" if num_grades == 1 else f"{num_grades} voti"
    
    if raw_grade < 1:
        return f"Ottimo! La tua media attuale è già sopra l'obiettivo. Anche con voti minimi raggiungerai {target_average}."
    elif raw_grade > 10:
        return f"Purtroppo non è possibile raggiungere {target_average} con {grade_text}. Prova a impostare un obiettivo più realistico o aggiungere più voti!"
    elif GRADE_ROUNDING_THRESHOLD <= raw_grade <= 10:
        return f"Ci vuole impegno! Ti serve {grade_text} da 10 (arrotondato da {display_grade}) per raggiungere l'obiettivo."
    elif raw_grade >= 9:
        return f"Devi impegnarti molto: ti serve {grade_text} da almeno {display_grade} per raggiungere l'obiettivo."
    elif raw_grade >= 7:
        return f"È fattibile: Con {grade_text} da {display_grade} puoi raggiungere {target_average}."
    elif raw_grade >= 6:
        return f"Ci sei quasi! {grade_text.capitalize()} da {display_grade} ti permetterà di raggiungere l'obiettivo."
    else:
        return f"Ottimo! Anche con {grade_text} modesti ({display_grade}) raggiungerai {target_average}."

@app.route('/predict_average', methods=['POST'])
def predict_average():
    """Predict how hypothetical grades will affect the average"""
    if 'grades_avr' not in flask.session:
        return flask.jsonify({'error': 'No active session'}), 401
    
    try:
        data = flask.request.get_json()
        period = data.get('period')
        subject = data.get('subject')
        predicted_grades = data.get('predicted_grades', [])
        
        grades_avr = flask.session['grades_avr']
        
        if period not in grades_avr or subject not in grades_avr[period]:
            return flask.jsonify({'error': 'Materia o periodo non trovato'}), 400
        
        if not predicted_grades or not isinstance(predicted_grades, list):
            return flask.jsonify({'error': 'Inserisci almeno un voto previsto'}), 400
        
        for grade in predicted_grades:
            if not isinstance(grade, (int, float)) or grade < 1 or grade > 10:
                return flask.jsonify({'error': 'Tutti i voti devono essere tra 1 e 10'}), 400
        
        subject_data = grades_avr[period][subject]
        if 'grades' not in subject_data or not isinstance(subject_data['grades'], list):
            return flask.jsonify({'error': 'Dati dei voti non validi'}), 400
        
        current_grades = _get_effective_grades(
            [g for g in subject_data['grades']
             if isinstance(g, dict) and 'decimalValue' in g and g['decimalValue'] is not None]
        )
        
        if not current_grades:
            return flask.jsonify({'error': 'Nessun voto disponibile per questa materia'}), 400
        
        current_average = subject_data.get('avr', sum(current_grades) / len(current_grades))
        
        all_grades = current_grades + predicted_grades
        predicted_average = sum(all_grades) / len(all_grades)
        
        change = predicted_average - current_average
        
        message = get_predict_message(change, predicted_average, len(predicted_grades))
        
        return flask.jsonify({
            'success': True,
            'current_average': round(current_average, 2),
            'predicted_average': round(predicted_average, 2),
            'change': round(change, 2),
            'num_predicted_grades': len(predicted_grades),
            'message': message
        }), 200
        
    except ValueError as e:
        return flask.jsonify({'error': 'Valori non validi'}), 400
    except Exception as e:
        return flask.jsonify({'error': 'Errore durante il calcolo'}), 500

def get_predict_message(change, predicted_average, num_grades):
    """Generate a helpful message based on the prediction result"""
    grade_text = "un voto" if num_grades == 1 else f"{num_grades} voti"
    
    if change > 0.5:
        return f"Ottimo! Con {grade_text} la tua media salirebbe a {round(predicted_average, 2)} ({change:+.2f})! 📈"
    elif change > 0:
        return f"Bene! Con {grade_text} la tua media migliorerebbe leggermente a {round(predicted_average, 2)} ({change:+.2f}). ✅"
    elif change == 0:
        return f"Con {grade_text} la tua media rimarrebbe stabile a {round(predicted_average, 2)}. ➡️"
    elif change > -0.5:
        return f"Attenzione! Con {grade_text} la tua media scenderebbe leggermente a {round(predicted_average, 2)} ({change:.2f}). ⚠️"
    else:
        return f"Attenzione! Con {grade_text} la tua media scenderebbe significativamente a {round(predicted_average, 2)} ({change:.2f}). 📉"

def should_exclude_blue_grades():
    """Check if blue grades should be excluded based on user preference in session.
    Default is False (include blue grades)."""
    include_blue = flask.session.get('include_blue_grades', True)
    return not include_blue

def get_all_grades(grades_avr, exclude_blue=None):
    """
    Collect all effective grades from all subjects in all periods.
    Component grades of the same evaluation are averaged into a single grade.
    
    Args:
        grades_avr: Dictionary containing grades organized by period and subject
        exclude_blue: If True, excludes blue grades. If None, uses session preference.
    
    Returns:
        List of decimal grade values (effective grades)
    """
    # Use session preference if exclude_blue not explicitly provided
    if exclude_blue is None:
        exclude_blue = should_exclude_blue_grades()
    
    all_grades_list = []
    for period in grades_avr:
        if period == 'all_avr':
            continue
        for subject in grades_avr[period]:
            if subject == 'period_avr':
                continue
            filtered_grades = [g for g in grades_avr[period][subject].get('grades', [])
                             if not (exclude_blue and g.get('isBlue', False))]
            all_grades_list.extend(_get_effective_grades(filtered_grades))
    return all_grades_list

@app.route('/calculate_goal_overall', methods=['POST'])
def calculate_goal_overall():
    """Calculate what grades are needed to reach a target overall average.
    If subject is provided, calculates for that subject. Otherwise, suggests best subjects to focus on."""
    if 'grades_avr' not in flask.session:
        return flask.jsonify({'error': 'No active session'}), 401
    
    try:
        data = flask.request.get_json()
        subject = data.get('subject')  # optional
        target_overall_average = float(data.get('target_average'))
        num_grades_input = data.get('num_grades')  # optional - will auto-calculate if not provided
        
        grades_avr = flask.session['grades_avr']
        
        if target_overall_average < 1 or target_overall_average > 10:
            return flask.jsonify({'error': 'La media target deve essere tra 1 e 10'}), 400
        
        current_overall_average = grades_avr.get('all_avr', 0)
        
        if current_overall_average >= target_overall_average:
            return flask.jsonify({
                'success': True,
                'current_overall_average': round(current_overall_average, 2),
                'target_average': target_overall_average,
                'suggestions': [],
                'num_grades': 0,
                'auto_calculated': True,
                'already_achieved': True,
                'message': f"🎉 Obiettivo già raggiunto! La tua media generale attuale ({round(current_overall_average, 2)}) è già pari o superiore all'obiettivo di {target_overall_average}."
            }), 200
        
        all_grades_list = get_all_grades(grades_avr)
        
        if not all_grades_list:
            return flask.jsonify({'error': 'Nessun voto disponibile'}), 400
        
        current_total = sum(all_grades_list)
        current_count = len(all_grades_list)
        
        if num_grades_input is None:
            num_grades, _ = calculate_optimal_grades_needed(current_total, current_count, target_overall_average)
            auto_calculated = True
        else:
            num_grades = int(num_grades_input)
            auto_calculated = False
            if num_grades < 1 or num_grades > 10:
                return flask.jsonify({'error': 'Il numero di voti deve essere tra 1 e 10'}), 400
        
        # Calculate required sum for new grades
        required_sum = target_overall_average * (current_count + num_grades) - current_total
        required_average_grade = required_sum / num_grades
        
        # If no subject specified, suggest the best subjects to focus on
        if not subject:
            suggestions = calculate_subject_suggestions(grades_avr, target_overall_average, num_grades, required_average_grade)
            
            return flask.jsonify({
                'success': True,
                'current_overall_average': round(current_overall_average, 2),
                'target_average': target_overall_average,
                'suggestions': suggestions,
                'num_grades': num_grades,
                'auto_calculated': auto_calculated,
                'message': get_smart_suggestion_message(suggestions, target_overall_average, num_grades)
            }), 200
        
        # If subject is specified, calculate for that specific subject
        # Find the subject in any period
        subject_found = False
        for period in grades_avr:
            if period == 'all_avr':
                continue
            if subject in grades_avr[period] and grades_avr[period][subject] != 'period_avr':
                subject_found = True
                break
        
        if not subject_found:
            return flask.jsonify({'error': 'Materia non trovata'}), 400
        
        # Round to nearest allowed grade
        display_grade = round_to_allowed_grade(required_average_grade)
        
        required_grades = [display_grade] * num_grades
        achievable = min(ALLOWED_GRADES) <= required_average_grade <= max(ALLOWED_GRADES)
        
        return flask.jsonify({
            'success': True,
            'current_overall_average': round(current_overall_average, 2),
            'target_average': target_overall_average,
            'required_grade': display_grade,
            'required_grades': required_grades,
            'current_grades_count': current_count,
            'achievable': achievable,
            'subject': subject,
            'message': get_goal_overall_message(required_average_grade, display_grade, target_overall_average, current_overall_average, num_grades, subject)
        }), 200
        
    except ValueError as e:
        return flask.jsonify({'error': 'Valori non validi'}), 400
    except Exception as e:
        logger.error(f"Error calculating overall goal: {e}", exc_info=True)
        return flask.jsonify({'error': 'Errore durante il calcolo'}), 500

def calculate_optimal_grades_needed(current_total, current_count, target_average):
    """Calculate the optimal/minimum number of grades needed to reach target average.
    
    Uses a heuristic: assume we can get perfect 10s, calculate minimum grades needed.
    Then provide a realistic plan with achievable grades.
    """
    # If already at or above target, no grades needed
    if current_count > 0 and (current_total / current_count) >= target_average:
        return 0, []
    
    # Calculate minimum grades needed assuming perfect 10s
    # Formula: (current_total + 10*n) / (current_count + n) = target_average
    # Solving for n: n = (current_total - target_average * current_count) / (target_average - 10)
    
    min_grades_needed = 1
    if target_average < 10:
        numerator = target_average * current_count - current_total
        denominator = 10 - target_average
        if denominator > 0:
            min_grades_needed = max(1, int(numerator / denominator) + 1)
    
    # Cap at reasonable number
    min_grades_needed = min(min_grades_needed, 5)
    
    # Calculate what grades are actually needed (realistic, not just 10s)
    required_sum = target_average * (current_count + min_grades_needed) - current_total
    required_average_grade = required_sum / min_grades_needed
    
    # If required grade is too high (>10), we need more grades at lower values
    while required_average_grade > 10 and min_grades_needed < 10:
        min_grades_needed += 1
        required_sum = target_average * (current_count + min_grades_needed) - current_total
        required_average_grade = required_sum / min_grades_needed
    
    grades_plan = [round(required_average_grade, 1)] * min_grades_needed
    
    return min_grades_needed, grades_plan

def calculate_subject_suggestions(grades_avr, target_overall_average, num_grades, baseline_required_grade):
    """Calculate which subjects would be easiest to focus on to reach the target overall average.
    Returns suggestions sorted by difficulty (easiest first).
    
    The algorithm uses a combined scoring approach:
    - Required grade: Lower required grades = easier to achieve
    - Impact: Fewer existing grades = higher impact per new grade
    - Combined score balances both factors to find optimal subjects
    """
    suggestions = []
    
    all_grades_list = get_all_grades(grades_avr)
    if not all_grades_list:
        return []
    
    current_total = sum(all_grades_list)
    current_count = len(all_grades_list)
    
    all_subjects = set()
    for period in grades_avr:
        if period == 'all_avr':
            continue
        for subject in grades_avr[period]:
            if subject != 'period_avr':
                all_subjects.add(subject)
    
    for subject in all_subjects:
        subject_grades = []
        for period in grades_avr:
            if period == 'all_avr':
                continue
            if subject in grades_avr[period]:
                subject_data = grades_avr[period][subject]
                if 'grades' in subject_data:
                    exclude_blue = should_exclude_blue_grades()
                    filtered = [g for g in subject_data['grades'] 
                                if not (exclude_blue and g.get('isBlue', False))]
                    subject_grades.extend(_get_effective_grades(filtered))
        
        if not subject_grades:
            continue
        
        current_subject_avg = sum(subject_grades) / len(subject_grades)
        
        # Formula: (current_total + required_sum) / (current_count + num_grades) = target_overall_average
        # required_sum = target_overall_average * (current_count + num_grades) - current_total
        required_sum = target_overall_average * (current_count + num_grades) - current_total
        required_average_grade = required_sum / num_grades if num_grades > 0 else 10
        
        display_required_grade = round_to_allowed_grade(required_average_grade)
        
        is_achievable = required_average_grade <= max(ALLOWED_GRADES)
        
        # Lower score = better suggestion
        impact_factor = 1.0 / (len(subject_grades) + num_grades) * 100
        combined_score = required_average_grade - (impact_factor * SUGGESTION_IMPACT_WEIGHT)
        
        suggestions.append({
            'subject': subject,
            'current_average': round(current_subject_avg, 2),
            'required_grade': display_required_grade,
            'raw_required_grade': round(required_average_grade, 2),
            'num_current_grades': len(subject_grades),
            'difficulty': round(combined_score, 2),
            'impact': round(impact_factor, 2),
            'is_achievable': is_achievable
        })
    
    # Sort by combined difficulty score (ascending) - lower = better target
    # Prioritize achievable suggestions
    suggestions.sort(key=lambda x: (not x['is_achievable'], x['difficulty']))
    
    # Return top suggestions
    return suggestions[:MAX_SUGGESTIONS]

def calculate_period_subject_suggestions(grades_avr, period, target_average, num_grades):
    """Calculate which subjects within a period would be easiest to focus on to reach the target average.
    Returns suggestions sorted by difficulty (easiest first).
    
    The algorithm calculates the required grade for each subject individually
    to reach the period target, then ranks them by achievability and difficulty.
    """
    suggestions = []
    
    # Get all subjects in the period
    if period not in grades_avr or period == 'all_avr':
        return []
    
    period_subjects = [s for s in grades_avr[period].keys() if s != 'period_avr']
    
    # Gather all period grades respecting user preference
    exclude_blue = should_exclude_blue_grades()
    all_period_grades = []
    for subject in period_subjects:
        subject_data = grades_avr[period][subject]
        if 'grades' in subject_data:
            filtered = [g for g in subject_data['grades']
                       if not (exclude_blue and g.get('isBlue', False))]
            all_period_grades.extend(_get_effective_grades(filtered))
    
    if not all_period_grades:
        return []
    
    current_period_total = sum(all_period_grades)
    current_period_count = len(all_period_grades)
    current_period_avg = current_period_total / current_period_count
    
    if current_period_avg >= target_average:
        return []  # Already achieved - no suggestions needed
    
    required_sum = target_average * (current_period_count + num_grades) - current_period_total
    baseline_required_grade = required_sum / num_grades if num_grades > 0 else 10
    
    for subject in period_subjects:
        subject_data = grades_avr[period][subject]
        
        # Get effective grades for this subject respecting user preference
        subject_grades = []
        if 'grades' in subject_data:
            filtered = [g for g in subject_data['grades'] 
                        if not (exclude_blue and g.get('isBlue', False))]
            subject_grades = _get_effective_grades(filtered)
        
        if not subject_grades:
            continue
        
        current_subject_avg = sum(subject_grades) / len(subject_grades)
        num_subject_grades = len(subject_grades)
        
        required_grade = baseline_required_grade
        
        # Achievability check
        is_achievable = required_grade <= max(ALLOWED_GRADES)
        
        # Display grade (rounded to allowed values)
        display_required_grade = round_to_allowed_grade(required_grade)
        
        impact_factor = 1.0 / (num_subject_grades + num_grades) * 100
        
        combined_score = required_grade - (impact_factor * SUGGESTION_IMPACT_WEIGHT)
        
        suggestions.append({
            'subject': subject,
            'current_average': round(current_subject_avg, 2),
            'required_grade': display_required_grade,
            'raw_required_grade': round(required_grade, 2),
            'num_current_grades': num_subject_grades,
            'difficulty': round(combined_score, 2),
            'impact': round(impact_factor, 2),
            'is_achievable': is_achievable
        })
    
    # Sort by achievability first, then by difficulty score (ascending)
    suggestions.sort(key=lambda x: (not x.get('is_achievable', True), x['difficulty']))
    
    # Return top suggestions
    return suggestions[:MAX_SUGGESTIONS]

def get_period_suggestion_message(suggestions, target_average, num_grades, period):
    """Generate an intelligent message about which subjects to focus on within a period"""
    if not suggestions:
        return f"Nessuna materia disponibile per il periodo {period}."
    
    grade_text = "un voto" if num_grades == 1 else f"{num_grades} voti"
    
    if suggestions[0]['required_grade'] > 10:
        return f"⚠️ Raggiungere {target_average} nel periodo {period} è molto difficile. Serve impegno in tutte le materie!"
    elif suggestions[0]['required_grade'] >= 9:
        top_subject = suggestions[0]['subject']
        return f"💪 Concentrati su {top_subject}! Servono {grade_text} da {suggestions[0]['required_grade']} per raggiungere {target_average} nel periodo {period}."
    elif suggestions[0]['required_grade'] >= 7:
        return f"✅ Obiettivo raggiungibile! Le materie consigliate sono elencate sotto - concentrati su quelle con voti più bassi!"
    else:
        return f"🎉 Ottimo! Anche con {grade_text} modesti puoi raggiungere {target_average} nel periodo {period}!"

def get_smart_suggestion_message(suggestions, target_average, num_grades):
    """Generate an intelligent message about which subjects to focus on"""
    if not suggestions:
        return "Nessuna materia disponibile per il calcolo."
    
    grade_text = "un voto" if num_grades == 1 else f"{num_grades} voti"
    
    if suggestions[0]['required_grade'] > 10:
        return f"⚠️ Raggiungere {target_average} di media generale è molto difficile. Serve impegno in tutte le materie!"
    elif suggestions[0]['required_grade'] >= 9:
        top_subject = suggestions[0]['subject']
        return f"💪 Concentrati su {top_subject}! Servono {grade_text} da {suggestions[0]['required_grade']} per raggiungere la media generale di {target_average}."
    elif suggestions[0]['required_grade'] >= 7:
        return f"✅ Obiettivo raggiungibile! Le materie consigliate sono elencate sotto - concentrati su quelle con voti più bassi!"
    else:
        return f"🎉 Ottimo! Anche con {grade_text} modesti puoi raggiungere {target_average} di media generale!"

def get_goal_overall_message(raw_grade, display_grade, target_average, current_average, num_grades, subject):
    """Generate message for overall average goal calculation"""
    grade_text = "un voto" if num_grades == 1 else f"{num_grades} voti"
    
    if raw_grade < min(ALLOWED_GRADES):
        return f"Ottimo! La tua media generale è già sopra l'obiettivo. Anche con voti minimi in {subject} raggiungerai {target_average}."
    elif raw_grade > max(ALLOWED_GRADES):
        return f"Purtroppo non è possibile raggiungere {target_average} di media generale con {grade_text} in {subject}. Prova un obiettivo più realistico!"
    elif display_grade >= 9.5:
        return f"Ci vuole impegno! Ti serve {grade_text} da {display_grade} in {subject} per raggiungere la media generale di {target_average}."
    elif raw_grade >= 9:
        return f"Devi impegnarti molto: ti serve {grade_text} da almeno {display_grade} in {subject} per raggiungere la media generale di {target_average}."
    elif raw_grade >= 7:
        return f"È fattibile: Con {grade_text} da {display_grade} in {subject} puoi raggiungere la media generale di {target_average}."
    elif raw_grade >= 6:
        return f"Ci sei quasi! {grade_text.capitalize()} da {display_grade} in {subject} ti permetterà di raggiungere la media generale di {target_average}."
    else:
        return f"Ottimo! Anche con {grade_text} modesti ({display_grade}) in {subject} raggiungerai la media generale di {target_average}."

@app.route('/predict_average_overall', methods=['POST'])
def predict_average_overall():
    """Predict how hypothetical grades in a subject will affect the overall average"""
    if 'grades_avr' not in flask.session:
        return flask.jsonify({'error': 'No active session'}), 401
    
    try:
        data = flask.request.get_json()
        period = data.get('period')
        subject = data.get('subject')
        predicted_grades = data.get('predicted_grades', [])
        
        grades_avr = flask.session['grades_avr']
        
        if period not in grades_avr or subject not in grades_avr[period]:
            return flask.jsonify({'error': 'Materia o periodo non trovato'}), 400
        
        if not predicted_grades or not isinstance(predicted_grades, list):
            return flask.jsonify({'error': 'Inserisci almeno un voto previsto'}), 400
        
        for grade in predicted_grades:
            if not isinstance(grade, (int, float)) or grade < 1 or grade > 10:
                return flask.jsonify({'error': 'Tutti i voti devono essere tra 1 e 10'}), 400
        
        current_overall_average = grades_avr.get('all_avr', 0)
        
        all_grades_list = get_all_grades(grades_avr)
        
        if not all_grades_list:
            return flask.jsonify({'error': 'Nessun voto disponibile'}), 400
        
        all_grades_with_predicted = all_grades_list + predicted_grades
        predicted_overall_average = sum(all_grades_with_predicted) / len(all_grades_with_predicted)
        
        change = predicted_overall_average - current_overall_average
        
        # Generate message
        message = get_predict_overall_message(change, predicted_overall_average, len(predicted_grades), subject)
        
        return flask.jsonify({
            'success': True,
            'current_overall_average': round(current_overall_average, 2),
            'predicted_overall_average': round(predicted_overall_average, 2),
            'change': round(change, 2),
            'num_predicted_grades': len(predicted_grades),
            'subject': subject,
            'period': period,
            'message': message
        }), 200
        
    except ValueError as e:
        return flask.jsonify({'error': 'Valori non validi'}), 400
    except Exception as e:
        logger.error(f"Error predicting overall average: {e}", exc_info=True)
        return flask.jsonify({'error': 'Errore durante il calcolo'}), 500

def get_predict_overall_message(change, predicted_average, num_grades, subject):
    """Generate a helpful message for overall average prediction"""
    grade_text = "un voto" if num_grades == 1 else f"{num_grades} voti"
    
    if change > 0.5:
        return f"Ottimo! Con {grade_text} in {subject} la tua media generale salirebbe a {round(predicted_average, 2)} ({change:+.2f})! 📈"
    elif change > 0:
        return f"Bene! Con {grade_text} in {subject} la tua media generale migliorerebbe leggermente a {round(predicted_average, 2)} ({change:+.2f}). ✅"
    elif change == 0:
        return f"Con {grade_text} in {subject} la tua media generale rimarrebbe stabile a {round(predicted_average, 2)}. ➡️"
    elif change > -0.5:
        return f"Attenzione! Con {grade_text} in {subject} la tua media generale scenderebbe leggermente a {round(predicted_average, 2)} ({change:.2f}). ⚠️"
    else:
        return f"Attenzione! Con {grade_text} in {subject} la tua media generale scenderebbe significativamente a {round(predicted_average, 2)} ({change:.2f}). 📉"

@app.route('/export/csv', methods=['POST'])
def export_csv():
    """Export grades as CSV file"""
    if 'grades_avr' not in flask.session:
        return flask.jsonify({'error': 'No active session', 'authenticated': False}), 401
    
    grades_avr = flask.session['grades_avr']
    
    output = io.StringIO()
    writer = csv.writer(output)
    
    writer.writerow(['Periodo', 'Materia', 'Voto', 'Data', 'Tipo', 'Docente', 'Note'])
    
    for period in sorted(grades_avr.keys()):
        if period == 'all_avr':
            continue
        
        for subject, data in grades_avr[period].items():
            if subject == 'period_avr':
                continue
            
            for grade in data.get('grades', []):
                writer.writerow([
                    f'Periodo {period}',
                    subject,
                    grade.get('decimalValue', ''),
                    grade.get('evtDate', ''),
                    grade.get('componentDesc', ''),
                    grade.get('teacherName', ''),
                    grade.get('notesForFamily', '')
                ])
    
    output.seek(0)
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    
    response = flask.Response(output.getvalue(), mimetype='text/csv')
    response.headers['Content-Disposition'] = f'attachment; filename=voti_{timestamp}.csv'
    
    return response

def login(user_id, user_pass):
    url = "https://web.spaggiari.eu/rest/v1/auth/login"
    headers = {
        "Content-Type": "application/json",
        "Z-Dev-ApiKey": "Tg1NWEwNGIgIC0K",
        "User-Agent": "CVVS/std/4.1.7 Android/10"
    }
    body = {
        "ident": None,
        "pass": user_pass,
        "uid": user_id
    }
    
    response = requests.post(url, headers=headers, data=json.dumps(body))
    
    if response.status_code == 200:
        return response.json()
    else:
        response.raise_for_status()

def get_periods(student_id, token):
    url = f"https://web.spaggiari.eu/rest/v1/students/{student_id}/periods"
    headers = {
        "Content-Type": "application/json",
        "Z-Dev-ApiKey": "Tg1NWEwNGIgIC0K",
        "User-Agent": "CVVS/std/4.1.7 Android/10",
        "Z-Auth-Token": token
    }
    response = requests.get(url, headers=headers)
    
    if response.status_code == 200:
        return response.json()
    else:
        response.raise_for_status()

def get_grades(student_id, token):
    url = f"https://web.spaggiari.eu/rest/v1/students/{student_id}/grades"
    headers = {
        "Content-Type": "application/json",
        "Z-Dev-ApiKey": "Tg1NWEwNGIgIC0K",
        "User-Agent": "CVVS/std/4.1.7 Android/10",
        "Z-Auth-Token": token
    }
    response = requests.get(url, headers=headers)
    if response.status_code == 200:
        return response.json()
    else:
        response.raise_for_status()

def _get_effective_grades(grades_list):
    """Compute effective grade values by averaging component grades of the same evaluation.
    
    Grades with non-empty componentDesc that share the same evtDate are components
    of the same evaluation (e.g., Scritto + Orale). These are averaged into a single
    effective grade so that multi-component evaluations count as one grade in averages.
    Standalone grades (empty componentDesc) are kept as-is.
    
    Note: This function is always called with grades already filtered by subject and period,
    so grouping by evtDate alone is sufficient to identify same-evaluation components.
    
    Returns a list of decimal grade values for average calculation.
    """
    standalone = []
    component_groups = {}
    
    for g in grades_list:
        if g.get('componentDesc'):
            key = g['evtDate']
            if key not in component_groups:
                component_groups[key] = []
            component_groups[key].append(g['decimalValue'])
        else:
            standalone.append(g['decimalValue'])
    
    effective = list(standalone)
    for values in component_groups.values():
        effective.append(sum(values) / len(values))
    
    return effective

def calculate_avr(grades):
    grades_avr = {}
    for grade in grades["grades"]:
        # ClasseViva API returns periodPos values that are offset by 1 from user-facing period numbers
        # For example, what users call "Periodo 2" has periodPos=3 in the API
        # We decrement by 1 to match user expectations
        period_pos = grade["periodPos"] - 1
        # ensure period is at least 1
        if period_pos < 1:
            period_pos = 1
        period = str(period_pos)
        # Determine decimal value: use API value, or fall back to displayValue + MARK_TABLE
        decimal_value = grade["decimalValue"]
        if decimal_value is None:
            display_value = grade.get("displayValue", "")
            decimal_value = MARK_TABLE.get(display_value, None)
            if decimal_value is not None:
                logger.debug(f"Recovered grade via displayValue '{display_value}' -> {decimal_value}")
            elif display_value:
                logger.warning(f"Grade skipped: decimalValue is null and displayValue '{display_value}' not in MARK_TABLE")
        # skip grades without a decimal value (so we exclude irc)
        if decimal_value is None:
            continue
        # Take all grades from Spaggiari as-is without filtering
        if period not in grades_avr:
            grades_avr[period] = {}
        if grades_avr[period].get(grade["subjectDesc"]) is None:
            grades_avr[period][grade["subjectDesc"]] = {"count": 0, "avr": 0, "grades": []}
        
        grades_avr[period][grade["subjectDesc"]]["count"] += 1
        
        # append grade as a dictionary with additional fields
        grades_avr[period][grade["subjectDesc"]]["grades"].append({
            "decimalValue": decimal_value,
            "displayValue": grade.get("displayValue", ""),
            "evtDate": grade["evtDate"],
            "notesForFamily": grade["notesForFamily"],
            "componentDesc": grade["componentDesc"],
            "teacherName": grade["teacherName"],
            "isBlue": grade["color"] == "blue"
        })
    
    # calculate average per subject
    # Component grades (grades with the same evtDate and non-empty componentDesc within a subject)
    # are averaged together into a single effective grade before computing the subject average.
    # This ensures that multi-component evaluations (e.g., Scritto + Orale) count as one grade.
    for period in grades_avr:
        for subject in grades_avr[period]:
            effective_grades = _get_effective_grades(grades_avr[period][subject]['grades'])
            grades_avr[period][subject]["avr"] = sum(effective_grades) / len(effective_grades) if effective_grades else 0
    
    # Calculate period averages (using effective grades per subject)
    for period in grades_avr:
        period_grades = []
        for subject in grades_avr[period]:
            period_grades.extend(_get_effective_grades(grades_avr[period][subject]['grades']))
        grades_avr[period]["period_avr"] = sum(period_grades) / len(period_grades) if period_grades else 0
    
    # Calculate overall average - use weighted average of all effective grades
    # Include all grades (including blue) for consistency with displayed averages
    all_grades = []
    for period in grades_avr:
        for subject in grades_avr[period]:
            if subject != 'period_avr':
                all_grades.extend(_get_effective_grades(grades_avr[period][subject]['grades']))
    grades_avr["all_avr"] = sum(all_grades) / len(all_grades) if all_grades else 0
    
    return grades_avr
    
if __name__ == "__main__":
    app.run(host='0.0.0.0', port=8001)
