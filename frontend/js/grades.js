// Theme management
const themeToggle = document.getElementById('themeToggle');
const root = document.documentElement;

// Function to get system preference
function getSystemTheme() {
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
    return 'light';
  }
  return 'dark';
}

// Load saved theme or use system preference
const savedTheme = localStorage.getItem('theme');
const initialTheme = savedTheme || getSystemTheme();

if (initialTheme === 'light') {
  root.setAttribute('data-theme', 'light');
}

// Toggle theme
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

// Get grade class based on value
function getGradeClass(value) {
  if (value >= 6.5) return 'excellent';
  if (value >= 5.5) return 'pass';
  return 'fail';
}

// Animate circle progress bars
function animateCircle(circle, targetValue) {
  const circumference = 327; // 2 * PI * r where r = 52
  const target = (targetValue / 10) * circumference;
  
  circle.style.strokeDashoffset = circumference;
  
  setTimeout(() => {
    circle.style.strokeDashoffset = circumference - target;
  }, 100);
}

// Render grades data
function renderGrades(gradesData) {
  const container = document.getElementById('gradesContainer');
  const overallCircle = document.getElementById('overallCircle');
  const overallGrade = document.getElementById('overallGrade');
  
  // Update overall average
  const allAvr = gradesData.all_avr || 0;
  overallGrade.textContent = allAvr.toFixed(1);
  overallGrade.className = `circle-grade grade-${getGradeClass(allAvr)}`;
  overallCircle.classList.add(getGradeClass(allAvr));
  animateCircle(overallCircle, allAvr);
  
  // Render periods and subjects
  let html = '';
  const periods = Object.keys(gradesData).filter(k => k !== 'all_avr').sort();
  
  for (const period of periods) {
    const subjects = gradesData[period];
    const periodAvr = subjects.period_avr || 0;
    
    html += `
      <div class="period-section">
        <div class="period-header">
          <h2 class="period-title">Periodo ${period}</h2>
          <span class="period-average ${getGradeClass(periodAvr)}">${periodAvr.toFixed(2)}</span>
        </div>
    `;
    
    for (const [subjectName, data] of Object.entries(subjects)) {
      if (subjectName === 'period_avr') continue;
      
      const subjectAvr = data.avr || 0;
      const encodedSubject = encodeURIComponent(subjectName);
      
      html += `
        <div class="subject-card ${getGradeClass(subjectAvr)}" onclick="navigateTo('subject_detail.html?subject=${encodedSubject}')">
          <div class="subject-header">
            <div class="subject-name">${escapeHtml(subjectName)}</div>
            <div class="subject-average">${subjectAvr.toFixed(1)}</div>
          </div>
          <div class="grade-badges">
      `;
      
      for (const grade of data.grades || []) {
        const gradeClass = grade.isBlue ? 'blue' : getGradeClass(grade.decimalValue);
        const gradeJson = JSON.stringify(grade).replace(/'/g, "\\'").replace(/"/g, '&quot;');
        html += `
          <button
            type="button"
            class="grade-badge ${gradeClass}"
            onclick="event.stopPropagation(); showModal(JSON.parse(this.getAttribute('data-grade')))"
            data-grade='${JSON.stringify(grade)}'
          >
            ${grade.decimalValue}
          </button>
        `;
      }
      
      html += `
          </div>
        </div>
      `;
    }
    
    html += '</div>';
  }
  
  container.innerHTML = html;
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function showModal(gradeData) {
  const modal = document.getElementById('gradeModal');
  const modalBody = document.getElementById('modalBody');
  
  let html = `
    <p><strong>Voto:</strong> <span style="font-weight: bold; font-size: 18px;">${gradeData.decimalValue}</span></p>
    <p><strong>Data:</strong> ${gradeData.evtDate || 'N/D'}</p>
    <p><strong>Componente:</strong> ${gradeData.componentDesc || 'N/D'}</p>
  `;
  
  if (gradeData.teacherName) {
    html += `<p><strong>Docente:</strong> ${gradeData.teacherName}</p>`;
  }
  
  if (gradeData.notesForFamily) {
    html += `<p><strong>Note:</strong> ${gradeData.notesForFamily}</p>`;
  } else {
    html += `<p><strong>Note:</strong> Nessuna nota</p>`;
  }
  
  if (gradeData.isBlue) {
    html += `<p><strong>Tipo:</strong> <span style="color: #2196F3;">Voto Blu</span></p>`;
  }
  
  modalBody.innerHTML = html;
  modal.classList.add('show');
}

function closeModal() {
  document.getElementById('gradeModal').classList.remove('show');
}

// Close modal when clicking outside
document.getElementById('gradeModal').addEventListener('click', function(e) {
  if (e.target === this) {
    closeModal();
  }
});

// Close modal with Escape key
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    closeModal();
  }
});

// Register Service Worker for PWA
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

// Handle logout from bottom nav and top button
const logoutNavBtn = document.getElementById('logoutNavBtn');
if (logoutNavBtn) {
  logoutNavBtn.addEventListener('click', performLogout);
}

const logoutBtn = document.getElementById('logoutBtn');
if (logoutBtn) {
  logoutBtn.addEventListener('click', performLogout);
}

// Fetch grades data on page load
async function loadGrades() {
  try {
    const response = await apiFetch('/grades');
    
    if (!response.ok) {
      if (response.status === 401) {
        // Not authenticated - redirect to login
        navigateTo('index.html');
        return;
      }
      throw new Error('Failed to load grades');
    }
    
    const data = await response.json();
    renderGrades(data);
  } catch (error) {
    console.error('Error loading grades:', error);
    document.getElementById('gradesContainer').innerHTML = `
      <div class="error-message">
        Errore nel caricamento dei voti. 
        <a href="index.html">Torna al login</a>
      </div>
    `;
  }
}

// Load grades when page loads
document.addEventListener('DOMContentLoaded', loadGrades);
