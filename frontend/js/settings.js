// Theme management
const themeToggle = document.getElementById('themeToggle');
const root = document.documentElement;

function getSystemTheme() {
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
    return 'light';
  }
  return 'dark';
}

const savedTheme = localStorage.getItem('theme');
const initialTheme = savedTheme || getSystemTheme();

if (initialTheme === 'light') {
  root.setAttribute('data-theme', 'light');
}

themeToggle.addEventListener('click', () => {
  const currentTheme = root.getAttribute('data-theme');
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  
  if (newTheme === 'light') {
    root.setAttribute('data-theme', 'light');
  } else {
    root.removeAttribute('data-theme');
  }
  
  localStorage.setItem('theme', newTheme);
});

// Notification helper
function showNotification(message, type = 'success') {
  const notification = document.getElementById('notification');
  notification.textContent = message;
  notification.className = `notification ${type} show`;
  setTimeout(() => {
    notification.classList.remove('show');
  }, 3000);
}

// Load version from API
async function loadVersion() {
  try {
    const response = await apiFetch('/api/chemediaho/settings');
    if (response.ok) {
      const data = await response.json();
      const versionEl = document.getElementById('appVersion');
      if (versionEl && data.version) {
        versionEl.textContent = `v${data.version}`;
      }
    }
  } catch (error) {
    console.error('Failed to load version:', error);
  }
}

// Blue grades preference toggle
const includeBlueGradesToggle = document.getElementById('includeBlueGradesToggle');
if (includeBlueGradesToggle) {
  // Load saved preference from localStorage (defaults to true - include blue grades)
  const savedPreference = localStorage.getItem('includeBlueGrades');
  const includeBlueGrades = savedPreference === null ? true : savedPreference === 'true';
  includeBlueGradesToggle.checked = includeBlueGrades;
  
  // Handle toggle change
  includeBlueGradesToggle.addEventListener('change', async () => {
    const include = includeBlueGradesToggle.checked;
    localStorage.setItem('includeBlueGrades', include);
    
    try {
      // Notify backend about the preference change using apiFetch
      const response = await apiFetch('/api/chemediaho/set_blue_grade_preference', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ include_blue_grades: include })
      });
      
      if (response.ok) {
        showNotification(include ? 'Medie aggiornate: voti blu inclusi' : 'Medie aggiornate: voti blu esclusi', 'success');
      } else {
        throw new Error('Errore nel salvataggio della preferenza');
      }
    } catch (error) {
      showNotification(error.message || 'Errore nel salvataggio della preferenza', 'error');
      // Revert toggle on error
      includeBlueGradesToggle.checked = !include;
      localStorage.setItem('includeBlueGrades', !include);
    }
  });
}

// Update app button (combines sync and clear cache)
const updateBtn = document.getElementById('updateBtn');
updateBtn.addEventListener('click', async () => {
  updateBtn.classList.add('loading');
  updateBtn.disabled = true;
  
  try {
    showNotification('Aggiornamento app in corso...', 'info');

    // Step 1: Clear cache
    await new Promise(resolve => setTimeout(resolve, 500));
    
    if ('caches' in window) {
      const cacheNames = await caches.keys();
      await Promise.all(cacheNames.map(name => caches.delete(name)));
    }
    
    // Step 2: Unregister Service Worker
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map(reg => reg.unregister()));
    }
    
    showNotification('✨ App aggiornata! Ricaricamento...', 'success');
    
    // Reload to grades page
    setTimeout(() => {
      navigateTo('grades.html');
    }, 1500);
  } catch (error) {
    showNotification(error.message || 'Errore durante l\'aggiornamento', 'error');
    updateBtn.classList.remove('loading');
    updateBtn.disabled = false;
  }
});

// Handle logout from bottom nav
const logoutNavBtn = document.getElementById('logoutNavBtn');
if (logoutNavBtn) {
  logoutNavBtn.addEventListener('click', performLogout);
}

// Register Service Worker for PWA (static frontend - same origin)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .then(registration => {
        console.log('Service Worker registered successfully:', registration.scope);
      })
      .catch(error => {
        console.log('Service Worker registration failed:', error);
      });
  });
}

// Load version on page load
document.addEventListener('DOMContentLoaded', loadVersion);
