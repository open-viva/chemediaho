// =============================================================================
// Overall Average Detail Page - Fetches data from API and renders dynamically
// =============================================================================

// Global state - will be loaded from API
let gradesData = {};

function formatPeriodLabel(period) {
  const value = String(period || '').trim();
  return value.toLowerCase().includes('periodo') ? value : `Periodo ${value}`;
}

// Load data from API
async function loadOverallData() {
  try {
    const response = await apiFetch('/api/chemediaho/overall_average_detail');
    
    if (!response.ok) {
      if (response.status === 401) {
        navigateTo('index.html');
        return;
      }
      throw new Error('Failed to load data');
    }
    
    gradesData = await response.json();
    
    // Render the page content
    renderOverallAverage();
    populateSubjectSelector();
    createOverallTrendChart();
    displaySavedGoal();
    
  } catch (error) {
    console.error('Error loading data:', error);
    showError('Errore nel caricamento dei dati');
  }
}

// Render overall average display
function renderOverallAverage() {
  const allAvr = gradesData.all_avr || 0;
  const overallCircle = document.getElementById('overallCircle');
  const overallGrade = document.getElementById('overallGrade');
  
  // Update text and class
  overallGrade.textContent = allAvr.toFixed(1);
  overallGrade.className = `circle-grade-large grade-${getGradeClass(allAvr)}`;
  overallCircle.classList.add(getGradeClass(allAvr));
  
  // Animate circle
  animateCircle(overallCircle, allAvr);
}

// Populate subject selector
function populateSubjectSelector() {
  const predictSubject = document.getElementById('predictSubject');
  if (!predictSubject) return;
  
  let options = '<option value="">Seleziona una materia...</option>';
  
  for (const period of Object.keys(gradesData).filter(k => k !== 'all_avr').sort()) {
    for (const subject of Object.keys(gradesData[period]).filter(k => k !== 'period_avr')) {
      options += `<option value="${subject}|${period}">${subject} (${formatPeriodLabel(period)})</option>`;
    }
  }
  
  predictSubject.innerHTML = options;
}

// Get grade class based on value
function getGradeClass(value) {
  if (value >= 6.5) return 'excellent';
  if (value >= 5.5) return 'pass';
  return 'fail';
}

// Animate circle progress bars
function animateCircle(circle, value) {
  const radius = 60;
  const circumference = 2 * Math.PI * radius;
  const target = (value / 10) * circumference;
  
  // Start from full (no progress)
  circle.style.strokeDashoffset = circumference;
  
  // Animate to target
  setTimeout(() => {
    circle.style.strokeDashoffset = circumference - target;
  }, 100);
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  loadOverallData();
});

// Create time series chart for overall average
function createOverallTrendChart() {
  const ctx = document.getElementById('overallTrendChart');
  if (!ctx) return;

  // Get theme colors
  const root = document.documentElement;
  const isDark = root.getAttribute('data-theme') !== 'light';
  const textColor = isDark ? '#f1e4e4' : '#1a0a0a';
  const gridColor = isDark ? 'rgba(241, 228, 228, 0.1)' : 'rgba(26, 10, 10, 0.1)';

  // Prepare data from all periods
  const periods = Object.keys(gradesData).filter(key => key !== 'all_avr').sort();
  const periodLabels = periods.map(p => formatPeriodLabel(p));
  const periodAverages = periods.map(p => gradesData[p].period_avr);

  new Chart(ctx, {
    type: 'line',
    data: {
      labels: periodLabels,
      datasets: [
        {
          label: 'Media per Periodo',
          data: periodAverages,
          borderColor: '#4facfe',
          backgroundColor: 'rgba(79, 172, 254, 0.2)',
          tension: 0.3,
          fill: true,
          pointRadius: 8,
          pointHoverRadius: 10,
          pointBackgroundColor: '#4facfe',
          pointBorderColor: '#fff',
          pointBorderWidth: 2
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          position: 'top',
          labels: {
            color: textColor,
            usePointStyle: true,
            padding: 15
          }
        },
        tooltip: {
          mode: 'index',
          intersect: false,
          backgroundColor: isDark ? 'rgba(19, 9, 9, 0.9)' : 'rgba(254, 248, 248, 0.9)',
          titleColor: textColor,
          bodyColor: textColor,
          borderColor: gridColor,
          borderWidth: 1,
          callbacks: {
            label: function(context) {
              return `Media: ${context.parsed.y.toFixed(2)}`;
            }
          }
        }
      },
      scales: {
        y: {
          beginAtZero: false,
          min: 3,
          max: 10,
          ticks: {
            color: textColor,
            stepSize: 0.5
          },
          grid: {
            color: gridColor
          }
        },
        x: {
          ticks: {
            color: textColor
          },
          grid: {
            color: gridColor
          }
        }
      }
    }
  });
}

// Goal persistence functions
function saveGoal(targetAverage, resultData) {
  const goal = {
    targetAverage: targetAverage,
    currentAverage: resultData.current_overall_average,
    numGrades: resultData.num_grades,
    timestamp: new Date().toISOString(),
    suggestions: resultData.suggestions || []
  };
  localStorage.setItem('overallGoal', JSON.stringify(goal));
  displaySavedGoal();
}

function loadSavedGoal() {
  return JSON.parse(localStorage.getItem('overallGoal'));
}

function displaySavedGoal() {
  const goal = loadSavedGoal();
  const savedGoalDisplay = document.getElementById('savedGoalDisplay');
  const savedGoalContent = document.getElementById('savedGoalContent');
  
  if (goal) {
    const date = new Date(goal.timestamp).toLocaleDateString('it-IT');
    const topSuggestion = goal.suggestions && goal.suggestions[0] ? goal.suggestions[0] : null;
    savedGoalContent.innerHTML = `
      <div style="margin-bottom: 4px;"><strong>Obiettivo:</strong> ${goal.targetAverage.toFixed(1)}</div>
      <div style="margin-bottom: 4px;"><strong>Media attuale:</strong> ${goal.currentAverage.toFixed(2)}</div>
      <div style="margin-bottom: 4px;"><strong>Voti necessari:</strong> ${goal.numGrades}</div>
      ${topSuggestion ? `<div style="margin-bottom: 4px;"><strong>Materia consigliata:</strong> ${topSuggestion.subject} (voto ${topSuggestion.required_grade})</div>` : ''}
      <div style="font-size: 12px; opacity: 0.7; margin-top: 8px;">Salvato il ${date}</div>
    `;
    savedGoalDisplay.style.display = 'block';
  } else {
    savedGoalDisplay.style.display = 'none';
  }
}

function clearSavedGoal() {
  localStorage.removeItem('overallGoal');
  displaySavedGoal();
}

// Display saved goal (called from loadOverallData)
// displaySavedGoal();

// Smart suggestions form handler
const smartSuggestionsForm = document.getElementById('smartSuggestionsForm');
const calculateBtn = document.getElementById('calculateBtn');
const resultCard = document.getElementById('resultCard');

smartSuggestionsForm.addEventListener('submit', async function(e) {
  e.preventDefault();
  
  const targetAverage = parseFloat(document.getElementById('targetAverage').value);
  
  if (!targetAverage || targetAverage < 1 || targetAverage > 10) {
    showError('Inserisci una media target valida (1-10)!');
    return;
  }

  calculateBtn.disabled = true;
  calculateBtn.textContent = 'Calcolo in corso...';

  try {
    const response = await apiFetch('/api/chemediaho/calculate_goal_overall', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        target_average: targetAverage
        // num_grades is now auto-calculated by backend
      })
    });

    const data = await response.json();

    if (response.ok && data.success) {
      displaySmartSuggestions(data);
      // Save goal to localStorage
      saveGoal(targetAverage, data);
    } else {
      showError(data.error || 'Errore durante il calcolo');
    }
  } catch (error) {
    showError('Errore di connessione');
  } finally {
    calculateBtn.disabled = false;
    calculateBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <polyline points="12 6 12 12 16 14"/>
      </svg>
      Calcola Suggerimenti
    `;
  }
});

function displaySmartSuggestions(data) {
  const suggestionsContainer = document.getElementById('suggestionsContainer');
  suggestionsContainer.innerHTML = '';
  
  // Add info about number of grades if auto-calculated
  if (data.auto_calculated && data.num_grades) {
    const infoBox = document.createElement('div');
    infoBox.style.cssText = 'background: rgba(255,255,255,0.05); padding: 12px; border-radius: 8px; margin-bottom: 16px; font-size: 14px;';
    infoBox.innerHTML = `
      <strong>📊 Piano Ottimale</strong><br/>
      Numero di voti consigliati: <strong>${data.num_grades}</strong> ${data.num_grades === 1 ? 'voto' : 'voti'}
    `;
    suggestionsContainer.appendChild(infoBox);
  }
  
  if (data.suggestions && data.suggestions.length > 0) {
    const header = document.createElement('h3');
    header.style.fontSize = '16px';
    header.style.fontWeight = 'bold';
    header.style.marginBottom = '12px';
    header.style.color = 'var(--text)';
    header.textContent = '📚 Materie Consigliate (ordinate per facilità):';
    suggestionsContainer.appendChild(header);
    
    data.suggestions.forEach((suggestion, index) => {
      const suggestionItem = document.createElement('div');
      suggestionItem.className = 'suggestion-item';
      
      const rank = index + 1;
      const emoji = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '📌';
      
      suggestionItem.innerHTML = `
        <div class="subject-name">${emoji} ${suggestion.subject}</div>
        <div class="suggestion-details">
          <span>Media attuale: ${suggestion.current_average}</span>
          <span class="required-grade">Voto necessario: ${suggestion.required_grade}</span>
        </div>
        <div style="font-size: 12px; margin-top: 4px; opacity: 0.7;">
          ${suggestion.num_current_grades} ${suggestion.num_current_grades === 1 ? 'voto attuale' : 'voti attuali'}
        </div>
      `;
      
      suggestionsContainer.appendChild(suggestionItem);
    });
  } else {
    suggestionsContainer.innerHTML = '<p style="opacity: 0.7;">Nessun suggerimento disponibile.</p>';
  }
  
  document.getElementById('resultMessage').textContent = data.message || '';
  resultCard.classList.add('show');
  resultCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function showError(message) {
  const notification = document.getElementById('errorNotification');
  notification.textContent = message;
  notification.classList.add('show');
  
  setTimeout(() => {
    notification.classList.remove('show');
  }, 3000);
}

// Predictions form handler
const predictionsForm = document.getElementById('predictionsForm');
const predictBtn = document.getElementById('predictBtn');
const predictionResult = document.getElementById('predictionResult');

predictionsForm.addEventListener('submit', async function(e) {
  e.preventDefault();
  
  const subjectPeriod = document.getElementById('predictSubject').value.split('|');
  const subject = subjectPeriod[0];
  const period = subjectPeriod[1];
  const gradesInput = document.getElementById('predictGrades').value;
  
  // Parse grades
  const predictedGrades = gradesInput.split(',').map(g => parseFloat(g.trim())).filter(g => !isNaN(g) && g >= 1 && g <= 10);
  
  if (predictedGrades.length === 0) {
    showError('Inserisci almeno un voto valido (1-10)!');
    return;
  }

  predictBtn.disabled = true;
  predictBtn.textContent = 'Calcolo in corso...';

  try {
    const response = await apiFetch('/api/chemediaho/predict_average_overall', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        period: period,
        subject: subject,
        predicted_grades: predictedGrades
      })
    });

    const data = await response.json();

    if (response.ok && data.success) {
      displayPrediction(data);
    } else {
      showError(data.error || 'Errore durante il calcolo');
    }
  } catch (error) {
    showError('Errore di connessione');
  } finally {
    predictBtn.disabled = false;
    predictBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
      </svg>
      Simula
    `;
  }
});

function displayPrediction(data) {
  const predictionContent = document.getElementById('predictionContent');
  predictionContent.innerHTML = '';
  
  const rows = [
    { label: 'Media Generale Attuale', value: data.current_overall_average },
    { label: 'Media Generale Prevista', value: data.predicted_overall_average, highlight: true },
    { label: 'Variazione', value: (data.change >= 0 ? '+' : '') + data.change, highlight: true },
    { label: 'Materia', value: data.subject },
    { label: 'Voti Simulati', value: data.num_predicted_grades }
  ];
  
  rows.forEach(row => {
    const rowEl = document.createElement('div');
    rowEl.className = 'result-row';
    rowEl.innerHTML = `
      <span class="result-label">${row.label}</span>
      <span class="result-value ${row.highlight ? 'highlight' : ''}">${row.value}</span>
    `;
    predictionContent.appendChild(rowEl);
  });
  
  document.getElementById('predictionMessage').textContent = data.message || '';
  predictionResult.classList.add('show');
  predictionResult.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
