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

// Handle logout from bottom nav
const logoutNavBtn = document.getElementById('logoutNavBtn');
if (logoutNavBtn) {
  logoutNavBtn.addEventListener('click', performLogout);
}

// Handle logout from top button
const logoutBtn = document.getElementById('logoutBtn');
if (logoutBtn) {
  logoutBtn.addEventListener('click', performLogout);
}

// Handle CSV export form submission
const csvExportForm = document.getElementById('csvExportForm');
const csvExportBtn = document.getElementById('csvExportBtn');

if (csvExportForm) {
  csvExportForm.addEventListener('submit', async function(e) {
    e.preventDefault();
    
    csvExportBtn.disabled = true;
    const originalText = csvExportBtn.innerHTML;
    csvExportBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="7 10 12 15 17 10"/>
        <line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
      Scaricamento...
    `;
    
    try {
      const response = await apiFetch('/api/chemediaho/export/csv', {
        method: 'POST'
      });
      
      if (!response.ok) {
        if (response.status === 401) {
          // Session expired - redirect to login
          navigateTo('index.html');
          return;
        }
        throw new Error('Errore durante l\'esportazione');
      }
      
      // Get the blob from response
      const blob = await response.blob();
      
      // Create download link
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'voti.csv';
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (error) {
      console.error('Export error:', error);
      alert('Errore durante l\'esportazione. Riprova.');
    } finally {
      csvExportBtn.disabled = false;
      csvExportBtn.innerHTML = originalText;
    }
  });
}

// Check session on page load
async function checkSession() {
  try {
    const response = await apiFetch('/api/chemediaho/export');
    if (!response.ok) {
      // Not authenticated - redirect to login
      navigateTo('index.html');
    }
  } catch (error) {
    console.error('Session check failed:', error);
    navigateTo('index.html');
  }
}

document.addEventListener('DOMContentLoaded', checkSession);
