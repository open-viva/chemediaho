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

function formatPeriodLabel(period) {
  const value = String(period || '').trim();
  return value.toLowerCase().includes('periodo') ? value : `Periodo ${value}`;
}

function parseGradeDecimalValue(grade) {
  if (!grade || typeof grade !== 'object') return null;
  const numericPattern = /^\d+(?:[.,]\d+)?$/;

  if (typeof grade.decimalValue === 'number' && Number.isFinite(grade.decimalValue)) {
    return grade.decimalValue;
  }

  if (typeof grade.decimalValue === 'string') {
    const cleanedDecimal = grade.decimalValue.trim();
    if (numericPattern.test(cleanedDecimal)) {
      const parsedDecimal = Number.parseFloat(cleanedDecimal.replace(',', '.'));
      if (Number.isFinite(parsedDecimal)) return parsedDecimal;
    }
  }

  if (typeof grade.displayValue === 'string') {
    const cleanedDisplay = grade.displayValue.trim();
    if (numericPattern.test(cleanedDisplay)) {
      const parsedDisplay = Number.parseFloat(cleanedDisplay.replace(',', '.'));
      if (Number.isFinite(parsedDisplay)) return parsedDisplay;
    }
  }

  return null;
}

function getEffectiveGrades(gradesList) {
  const standalone = [];
  const componentGroups = {};

  for (const grade of gradesList || []) {
    if (grade.componentDesc) {
      const evtId = grade.evtId;
      const key = evtId !== null && evtId !== undefined ? evtId : grade.evtDate;
      if (key !== null && key !== undefined && key !== '') {
        if (!componentGroups[key]) componentGroups[key] = [];
        componentGroups[key].push(grade.decimalValue);
      } else {
        standalone.push(grade.decimalValue);
      }
    } else {
      standalone.push(grade.decimalValue);
    }
  }

  const effective = [...standalone];
  for (const values of Object.values(componentGroups)) {
    effective.push(values.reduce((sum, value) => sum + value, 0) / values.length);
  }

  return effective;
}

function normalizeOpenvivaGradesPayload(payload) {
  if (!payload || typeof payload !== 'object') return { all_avr: 0 };
  if (Object.prototype.hasOwnProperty.call(payload, 'all_avr')) return payload;
  if (!Array.isArray(payload.grades)) return payload;

  const normalized = {};

  for (const rawGrade of payload.grades) {
    if (!rawGrade || typeof rawGrade !== 'object') continue;

    const decimalValue = parseGradeDecimalValue(rawGrade);
    if (decimalValue === null) continue;

    const period = String(rawGrade.periodLabel || rawGrade.periodDesc || (rawGrade.periodPos !== undefined && rawGrade.periodPos !== null ? `Periodo ${rawGrade.periodPos}` : 'Periodo sconosciuto')).trim();
    const subject = String(rawGrade.subjectDesc || rawGrade.subjectCode || 'Materia sconosciuta').trim() || 'Materia sconosciuta';

    if (!normalized[period]) normalized[period] = {};
    if (!normalized[period][subject]) normalized[period][subject] = { count: 0, avr: 0, grades: [] };

    normalized[period][subject].count += 1;
    normalized[period][subject].grades.push({
      decimalValue,
      displayValue: rawGrade.displayValue || '',
      evtId: rawGrade.evtId,
      evtDate: rawGrade.evtDate || '',
      notesForFamily: rawGrade.notesForFamily || '',
      componentDesc: rawGrade.componentDesc || '',
      teacherName: rawGrade.teacherName || '',
      isBlue: String(rawGrade.color || '').toLowerCase() === 'blue'
    });
  }

  for (const period of Object.keys(normalized)) {
    const periodEffective = [];
    for (const subject of Object.keys(normalized[period])) {
      const subjectEffective = getEffectiveGrades(normalized[period][subject].grades);
      normalized[period][subject].avr = subjectEffective.length
        ? subjectEffective.reduce((sum, value) => sum + value, 0) / subjectEffective.length
        : 0;
      periodEffective.push(...subjectEffective);
    }
    normalized[period].period_avr = periodEffective.length
      ? periodEffective.reduce((sum, value) => sum + value, 0) / periodEffective.length
      : 0;
  }

  const allEffective = [];
  for (const period of Object.keys(normalized)) {
    for (const [subject, subjectData] of Object.entries(normalized[period])) {
      if (subject === 'period_avr') continue;
      allEffective.push(...getEffectiveGrades(subjectData.grades));
    }
  }
  normalized.all_avr = allEffective.length
    ? allEffective.reduce((sum, value) => sum + value, 0) / allEffective.length
    : 0;

  return normalized;
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
          <h2 class="period-title">${formatPeriodLabel(period)}</h2>
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
    const response = await apiFetch('/api/grades');
    
    if (!response.ok) {
      if (response.status === 401) {
        // Not authenticated - redirect to login
        navigateTo('index.html');
        return;
      }
      throw new Error('Failed to load grades');
    }
    
    const data = await response.json();
    const normalizedData = normalizeOpenvivaGradesPayload(data);
    renderGrades(normalizedData);
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
