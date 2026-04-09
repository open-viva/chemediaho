/**
 * Centralized API helper for che media ho?
 * 
 * This module provides functions for making backend API calls.
 * All backend communication MUST go through these functions to ensure:
 * - Consistent base URL handling
 * - Automatic API key injection
 * - Proper credentials handling for cross-origin sessions
 * 
 * Usage:
 *   apiFetch('/api/login', { method: 'POST', body: formData })
 *   apiFetch('/grades')
 *   apiFetch('/calculate_goal', { method: 'POST', body: JSON.stringify(data), headers: { 'Content-Type': 'application/json' } })
 */

/**
 * Make a fetch request to the backend API
 * @param {string} path - The API path (e.g., '/api/login', '/grades')
 * @param {object} options - Fetch options (method, headers, body, etc.)
 * @returns {Promise<Response>} - The fetch response
 */
function apiFetch(path, options = {}) {
  // Get configuration - fail loudly if not available
  if (!window.APP_CONFIG) {
    console.error('[apiFetch] APP_CONFIG is not defined. Make sure config.runtime.js is loaded before api.js');
    throw new Error('APP_CONFIG is not defined');
  }
  
  const { API_BASE, API_KEY } = window.APP_CONFIG;
  
  // Build the full URL
  // API_BASE can be empty (same-origin), a relative path, or full URL
  const url = API_BASE ? `${API_BASE}${path}` : path;
  
  // Merge headers - add API key if configured
  const headers = {
    ...(options.headers || {}),
    ...(API_KEY ? { 'X-API-Key': API_KEY } : {})
  };
  
  // Make the request with credentials for cross-origin session support
  return fetch(url, {
    credentials: 'include',  // Required for cookies/session across origins
    ...options,
    headers
  });
}

/**
 * Navigate to a frontend page (static HTML files)
 * @param {string} page - The page to navigate to (e.g., 'grades.html', 'settings.html')
 */
function navigateTo(page) {
  window.location.href = page;
}

/**
 * Submit a form via POST to a backend route
 * Replaces HTML form submissions with JavaScript-based submission
 * @param {string} path - The backend route path
 * @param {FormData|object} data - Form data to submit
 * @param {object} options - Additional options
 * @returns {Promise<Response>} - The fetch response
 */
async function apiFormSubmit(path, data, options = {}) {
  const body = data instanceof FormData ? data : new URLSearchParams(data);
  
  return apiFetch(path, {
    method: 'POST',
    body,
    ...options
  });
}

/**
 * Perform logout - calls backend and redirects to login
 */
async function performLogout() {
  try {
    await apiFetch('/logout', { method: 'POST' });
  } catch (error) {
    console.error('Logout error:', error);
  }
  // Always redirect to login page
  navigateTo('index.html');
}

/**
 * Check if user is authenticated by calling a protected endpoint
 * @returns {Promise<boolean>} - True if authenticated
 */
async function checkAuth() {
  try {
    const response = await apiFetch('/grades');
    return response.ok;
  } catch (error) {
    return false;
  }
}

// Make functions globally available
window.apiFetch = apiFetch;
window.navigateTo = navigateTo;
window.apiFormSubmit = apiFormSubmit;
window.performLogout = performLogout;
window.checkAuth = checkAuth;
