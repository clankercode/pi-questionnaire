const BOOT = globalThis.__PI_QUESTIONNAIRE_BOOT__;
let state = { questions: BOOT.questions, currentTab: BOOT.currentTab, answers: BOOT.answers || {}, options: BOOT.options || {notes:{}}, lifecycle: BOOT.lifecycle || 'open', renderOptions: BOOT.renderOptions };
let socket;
let expanded = new Set();
let sendTimer;
let pendingSendMessages = [];
let reconnectTimer;
let reconnectDelay = 500;
let terminalLifecycle = state.lifecycle !== 'open';
let awaitingState = !terminalLifecycle;
let reviewReturnTab = Math.max(0, Math.min(state.questions.length - 1, state.currentTab));
const SUBMIT_DEBOUNCE_MS = (BOOT && typeof BOOT.submitDebounceMs === 'number') ? BOOT.submitDebounceMs : 250;
let submitReadyAt = Date.now(); // single-question: already past debounce at mount
const AUTO_CLOSE_SECONDS = 5 * 60;
let autoCloseRemainingSeconds = AUTO_CLOSE_SECONDS;
let autoCloseInterval = null;
let autoCloseTimerRunning = false;
let autoCloseCancelled = false;
function connect(){
  if(terminalLifecycle) return;
  clearTimeout(reconnectTimer);
  setOverlayPending(true, 'Connecting to TUI...');
  socket = new WebSocket(BOOT.wsUrl);
  socket.onopen = () => { reconnectDelay = 500; document.getElementById('status').textContent = 'Connected'; setOverlayPending(true, 'Loading TUI state...'); };
  socket.onclose = () => { if(terminalLifecycle) return; document.getElementById('status').textContent = 'Disconnected; reconnecting...'; setOverlayPending(true, 'Reconnecting to TUI...'); reconnectTimer = setTimeout(connect, reconnectDelay); reconnectDelay = Math.min(8000, reconnectDelay * 2); };
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const dom = applyServerMessage(message);
    if(message.type === 'state') setOverlayPending(false);
    if(dom.needsRender) render();
    else {
      if(dom.needsActiveUpdate) updateActiveQuestionClasses();
      updateLifecycleOverlay();
    }
  };
}
function sameJson(left,right){ return JSON.stringify(left) === JSON.stringify(right); }
function applyLifecycle(lifecycle){
  if(!lifecycle) return false;
  const changed = state.lifecycle !== lifecycle || terminalLifecycle !== (lifecycle !== 'open');
  state.lifecycle = lifecycle;
  if(lifecycle !== 'open'){
    terminalLifecycle = true;
    clearTimeout(reconnectTimer);
    setOverlayPending(false);
    document.getElementById('status').textContent = lifecycle === 'submitted' ? 'Submitted' : 'Cancelled';
    if(lifecycle === 'cancelled') stopAutoCloseTimer();
  }
  return changed;
}
function applyServerMessage(message){
  const dom = { needsRender:false, needsActiveUpdate:false };
  const focusedTextControl = isTextValueControl(document.activeElement);
  if(message.type === 'state'){
    if(!sameJson(state.questions, message.questions || [])){ state.questions = message.questions || []; reviewReturnTab = Math.max(0, Math.min(state.questions.length - 1, reviewReturnTab)); dom.needsRender = true; }
    if(state.currentTab !== message.currentTab){ const wasSubmit = state.currentTab === state.questions.length; state.currentTab = message.currentTab; if(state.currentTab < state.questions.length) reviewReturnTab = state.currentTab; dom.needsRender = wasSubmit || state.currentTab === state.questions.length; dom.needsActiveUpdate = !dom.needsRender; }
    const nextAnswers = protectFocusedAnswer(message.answers || {});
    if(!sameJson(state.answers, nextAnswers)){ state.answers = nextAnswers; if(!focusedTextControl) dom.needsRender = true; }
    const nextOptions = protectFocusedOptions(message.options || {notes:{}});
    if(!sameJson(state.options, nextOptions)){ state.options = nextOptions; if(!focusedTextControl) dom.needsRender = true; }
    if(message.lifecycle && message.lifecycle !== 'open') terminalLifecycle = true;
    if(applyLifecycle(message.lifecycle)) dom.needsRender = true;
    return dom;
  }
  if(message.type === 'tab' && state.currentTab !== message.currentTab){ const wasSubmit = state.currentTab === state.questions.length; state.currentTab = message.currentTab; if(state.currentTab < state.questions.length) reviewReturnTab = state.currentTab; dom.needsRender = wasSubmit || state.currentTab === state.questions.length; dom.needsActiveUpdate = !dom.needsRender; }
  if(message.type === 'answers'){
    const nextAnswers = protectFocusedAnswer(message.answers || {});
    if(!sameJson(state.answers, nextAnswers)){ state.answers = nextAnswers; if(!focusedTextControl) dom.needsRender = true; }
  }
  if(message.type === 'options'){
    const protectedAnswers = protectFocusedAnswer(state.answers);
    if(!sameJson(state.answers, protectedAnswers)) state.answers = protectedAnswers;
    const nextOptions = protectFocusedOptions(message.options || {notes:{}});
    if(!sameJson(state.options, nextOptions)){ state.options = nextOptions; if(!focusedTextControl) dom.needsRender = true; }
  }
  if(message.type === 'lifecycle' && message.lifecycle !== 'open'){
    if(applyLifecycle(message.lifecycle)) dom.needsRender = true;
  }
  return dom;
}
function setOverlayPending(pending, text){
  awaitingState = pending && !terminalLifecycle;
  if(text) document.getElementById('overlay').textContent = text;
  updateLifecycleOverlay();
}
function updateLifecycleOverlay(){ document.getElementById('overlay').classList.toggle('visible', awaitingState && !terminalLifecycle); }
function setActionsVisible(visible){ document.getElementById('actions').style.display = visible ? '' : 'none'; }
function missingAnswerCount(){ let n=0; state.questions.forEach((_,i)=>{ const answer=currentAnswer(i); if(answer === undefined || answer === '' || (Array.isArray(answer) && answer.length === 0)) n++; }); return n; }
function allAnswered(){ return missingAnswerCount() === 0; }
function updateActionLabels(){
  const reviewing = isReviewTab();
  const missing = missingAnswerCount();
  const submit = document.getElementById('submit');
  const debounceActive = reviewing && Date.now() < submitReadyAt;
  submit.textContent = debounceActive ? 'Please wait...' : reviewing ? 'Confirm Submit' : 'Submit';
  submit.disabled = missing > 0 || debounceActive;
  submit.setAttribute('aria-disabled', (missing > 0 || debounceActive) ? 'true' : 'false');
  const warning = document.getElementById('submit-warning');
  if(warning) warning.textContent = missing > 0 ? 'Answer all questions before submitting — '+missing+' remaining.' : '';
  const reviewBack = document.getElementById('review-back');
  if(reviewBack) reviewBack.style.display = reviewing ? '' : 'none';
}
function updateActiveQuestionClasses(){ document.querySelectorAll('#questions .question').forEach((section,i)=>section.classList.toggle('active', i === state.currentTab)); updateLayoutMode(); renderProgress(); updateActionLabels(); }
function answeredCount(){ let n=0; state.questions.forEach((_,i)=>{ if(currentAnswer(i) !== undefined) n++; }); return n; }
function renderProgress(){
  const bar = document.getElementById('progress'); if(!bar) return;
  bar.innerHTML = '';
  const isReview = isReviewTab();
  const total = state.questions.length;
  const answered = answeredCount();
  state.questions.forEach((_,i)=>{
    const btn = document.createElement('button'); btn.type='button';
    btn.className = 'progress-step' + (i === state.currentTab && !isReview ? ' active' : '') + (currentAnswer(i) !== undefined ? ' answered' : '');
    btn.textContent = String(i+1);
    btn.onclick = ()=> { if(isReviewTab()){ setTab(i); render(); } else setTab(i); };
    bar.appendChild(btn);
  });
  if(total >= 2){
    const rev = document.createElement('button'); rev.type='button';
    rev.className = 'progress-step review' + (isReview ? ' active' : '');
    rev.textContent = '\u2713';
    rev.title = 'Review';
    rev.onclick = ()=> showSubmitReview();
    bar.appendChild(rev);
  }
  const info = document.createElement('span'); info.className = 'progress-info';
  if(isReview){ info.innerHTML = '<strong>Review</strong> &middot; ' + answered + ' of ' + total + ' answered'; }
  else { info.innerHTML = '<strong>Step '+(state.currentTab+1)+' / '+total+'</strong> &middot; ' + answered + ' answered'; }
  bar.appendChild(info);
}
function send(message){ if(message && socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); }
function pendingKey(message){ return message.type === 'answer' ? 'answer:'+message.questionId : message.type; }
function queuePending(message){
  const key = pendingKey(message);
  const idx = pendingSendMessages.findIndex(item => item.key === key);
  if(idx === -1) pendingSendMessages.push({key, message});
  else pendingSendMessages[idx] = {key, message};
}
function sendDebounced(message){ queuePending(message); clearTimeout(sendTimer); sendTimer = setTimeout(flushDebounced, 120); }
function flushDebounced(){ if(pendingSendMessages.length === 0) return; clearTimeout(sendTimer); const messages = pendingSendMessages; pendingSendMessages = []; messages.forEach(item => send(item.message)); }
function setLocalAnswer(i,value){ if(value === null) delete state.answers[String(i)]; else state.answers[String(i)] = value; }
function protectFocusedAnswer(answers){
  const el = document.activeElement;
  const match = el && el.dataset && /^q-(\\d+)-(input|other)$/.exec(el.dataset.focusKey || '');
  if(!match) return answers;
  const i = Number(match[1]);
  const role = match[2];
  const q = state.questions[i];
  if(!q) return answers;
  if(role === 'input' && q.type === 'free_text') return {...answers, [String(i)]: el.value};
  if(role === 'other' && (q.type === 'select_one' || q.type === 'select_many' || q.type === 'confirm_enum')){
    const value = answerValue(q,i,el);
    if(value === null){ const next = {...answers}; delete next[String(i)]; return next; }
    return {...answers, [String(i)]: value};
  }
  return answers;
}
function protectFocusedOptions(options){
  const el = document.activeElement;
  const match = el && el.dataset && /^q-(\\d+)-notes$/.exec(el.dataset.focusKey || '');
  if(!match) return options;
  const q = state.questions[Number(match[1])];
  if(!q) return options;
  return {...options, notes:{...(options.notes || {}), [q.id]:el.value}};
}
function currentAnswer(i){ return state.answers[String(i)]; }
function optionValue(opt){ return opt.isOther ? '__other__' : opt.label; }
function isOtherSentinelText(text){ return String(text || '').trim().toLowerCase() === '__other__'; }
function isOtherAnswer(answer){ return answer && typeof answer === 'object' && !Array.isArray(answer) && answer.mode === 'other' && !isOtherSentinelText(answer.text); }
function choiceValue(answer){ return answer && typeof answer === 'object' && !Array.isArray(answer) && answer.mode === 'option' ? answer.value : undefined; }
function isChoiceChecked(q,i,opt){
  const answer = currentAnswer(i);
  if(q.type === 'select_many'){
    return Array.isArray(answer) && answer.some(x => opt.isOther ? isOtherAnswer(x) : choiceValue(x) === opt.label);
  }
  return opt.isOther ? isOtherAnswer(answer) : choiceValue(answer) === (q.type === 'confirm_enum' && opt.label === 'Affirm' ? 'affirm' : q.type === 'confirm_enum' && opt.label === 'Decline' ? 'decline' : opt.label);
}
function otherAnswerText(i){
  const answer = currentAnswer(i);
  if(Array.isArray(answer)){ const other = answer.find(isOtherAnswer); return other ? other.text || '' : ''; }
  return isOtherAnswer(answer) ? answer.text || '' : '';
}
function otherInputId(q,i){ return 'other-'+i+'-'+String(q.id || i).replace(/[^a-zA-Z0-9_-]/g, '_'); }
function isOtherTextInput(el){ return el && el.dataset && el.dataset.inputRole === 'other'; }
function otherTextValue(q,i,el){
  if(isOtherTextInput(el)) return el.value;
  const otherInput = document.getElementById(otherInputId(q,i));
  return otherInput ? otherInput.value : '';
}
function otherAnswerValue(q,i,el){
  const text = otherTextValue(q,i,el);
  return text && !isOtherSentinelText(text) ? {mode:'other', text} : null;
}
function answerValue(q,i,el){
  if(q.type === 'select_one'){
    if(isOtherTextInput(el) || el.value === '__other__') return otherAnswerValue(q,i,el);
    return {mode:'option', value:el.value};
  }
  if(q.type === 'select_many'){
    return Array.from(document.querySelectorAll('[name="q'+i+'"]:checked')).map(x => {
      if(x.value === '__other__') return otherAnswerValue(q,i,isOtherTextInput(el) ? el : x);
      return {mode:'option', value:x.value};
    }).filter(Boolean);
  }
  if(q.type === 'confirm_enum'){
    if(isOtherTextInput(el) || el.value === '__other__') return otherAnswerValue(q,i,el);
    return {mode:'option', value: el.value.toLowerCase() === 'affirm' ? 'affirm' : 'decline'};
  }
  if(q.type === 'number') return el.value === '' ? null : Number(el.value);
  return el.value;
}
function setTab(i){ state.currentTab = i; if(i < state.questions.length) reviewReturnTab = i; send({type:'tab', currentTab:i}); updateActiveQuestionClasses(); }
function isReviewTab(){ return state.currentTab === state.questions.length; }
function reviewBackTab(){ return Math.max(0, Math.min(state.questions.length - 1, reviewReturnTab)); }
function showSubmitReview(){ flushDebounced(); reviewReturnTab = state.currentTab < state.questions.length ? state.currentTab : reviewBackTab(); submitReadyAt = Date.now() + SUBMIT_DEBOUNCE_MS; setTab(state.questions.length); render(); }
function returnFromSubmitReview(){ setTab(reviewBackTab()); render(); }
function confirmSubmit(){ if(!allAnswered()){ updateActionLabels(); return; } if(Date.now() < submitReadyAt) return; flushDebounced(); send({type:'submit'}); }
function activateQuestion(i){ if(state.currentTab !== i) setTab(i); }
function isTextValueControl(el){
  if(!el) return false;
  if(el.tagName === 'TEXTAREA') return true;
  if(el.tagName !== 'INPUT') return false;
  return ['text','number','search','email','url','tel','password'].includes(el.type || 'text');
}
function captureFocus(){
  const el = document.activeElement;
  if(!el || !el.dataset || !el.dataset.focusKey) return null;
  const focus = { key:el.dataset.focusKey };
  if(isTextValueControl(el)) focus.value = el.value;
  if(typeof el.selectionStart === 'number' && typeof el.selectionEnd === 'number'){
    focus.start = el.selectionStart;
    focus.end = el.selectionEnd;
  }
  return focus;
}
function restoreFocus(focus){
  if(!focus) return;
  const el = document.querySelector('[data-focus-key="'+focus.key+'"]');
  if(!el) return;
  if(typeof focus.value === 'string' && isTextValueControl(el)) el.value = focus.value;
  el.focus({preventScroll:true});
  if(typeof focus.start === 'number' && typeof el.setSelectionRange === 'function') el.setSelectionRange(focus.start, focus.end);
}
function terminalText(){ return state.lifecycle === 'submitted' ? 'Questionnaire submitted.' : 'Questionnaire cancelled.'; }
function formatCountdown(seconds){
  const safe = Math.max(0, seconds);
  return String(Math.floor(safe / 60)).padStart(2, '0')+':'+String(safe % 60).padStart(2, '0');
}
function autoCloseTimerText(){ return autoCloseCancelled ? 'Auto-close timer cancelled.' : 'This tab will close in '+formatCountdown(autoCloseRemainingSeconds)+'.'; }
function updateAutoCloseTimerDisplay(){
  const timer = document.getElementById('auto-close-timer');
  if(timer) timer.textContent = autoCloseTimerText();
  const cancel = document.getElementById('cancel-auto-close');
  if(cancel) cancel.disabled = autoCloseCancelled;
}
function closeBrowserTab(){
  const browserWindow = typeof window !== 'undefined' ? window : globalThis;
  if(browserWindow && typeof browserWindow.close === 'function') browserWindow.close();
}
function stopAutoCloseTimer(){
  if(autoCloseTimerRunning && autoCloseInterval !== null && typeof clearInterval === 'function') clearInterval(autoCloseInterval);
  autoCloseInterval = null;
  autoCloseTimerRunning = false;
}
function tickAutoCloseTimer(){
  if(state.lifecycle !== 'submitted' || autoCloseCancelled){ stopAutoCloseTimer(); updateAutoCloseTimerDisplay(); return; }
  autoCloseRemainingSeconds = Math.max(0, autoCloseRemainingSeconds - 1);
  updateAutoCloseTimerDisplay();
  if(autoCloseRemainingSeconds === 0){ stopAutoCloseTimer(); closeBrowserTab(); }
}
function startAutoCloseTimer(){
  if(state.lifecycle !== 'submitted' || autoCloseCancelled || autoCloseTimerRunning){ updateAutoCloseTimerDisplay(); return; }
  autoCloseRemainingSeconds = AUTO_CLOSE_SECONDS;
  autoCloseTimerRunning = true;
  autoCloseInterval = setInterval(tickAutoCloseTimer, 1000);
  updateAutoCloseTimerDisplay();
}
function cancelAutoCloseTimer(){ autoCloseCancelled = true; stopAutoCloseTimer(); updateAutoCloseTimerDisplay(); }
function displayAnswerValue(value){
  if(value === undefined) return 'unanswered';
  if(Array.isArray(value)) return value.map(displayAnswerValue).join(', ');
  if(value && typeof value === 'object'){
    if(value.mode === 'option') return String(value.value);
    if(value.mode === 'other') return isOtherSentinelText(value.text) ? 'unanswered' : '(Other) '+String(value.text || '');
    return JSON.stringify(value);
  }
  return String(value);
}
function renderReviewLedger(root){
  const desc = document.createElement('p'); desc.className = 'muted'; desc.style.cssText = 'color:#64748b;margin:0 0 1.25rem;font-size:.9375rem';
  desc.textContent = 'Review your answers, then choose Confirm Submit or Back.';
  root.appendChild(desc);
  const table = document.createElement('div'); table.className = 'review-ledger';
  state.questions.forEach((q,i)=>{
    const row = document.createElement('div'); row.className = 'ledger-row';
    const num = document.createElement('div'); num.className = 'q-num'; num.textContent = (i+1) + '. ' + q.header;
    row.appendChild(num);
    const qLabel = document.createElement('div'); qLabel.className = 'ledger-label'; qLabel.textContent = 'QUESTION';
    const qVal = document.createElement('div'); qVal.className = 'ledger-value'; qVal.textContent = q.question;
    row.append(qLabel, qVal);
    const aLabel = document.createElement('div'); aLabel.className = 'ledger-label'; aLabel.textContent = 'ANSWER';
    const aVal = document.createElement('div'); aVal.className = 'ledger-answer';
    const ans = displayAnswerValue(currentAnswer(i));
    aVal.textContent = ans;
    if(ans === 'unanswered') aVal.classList.add('ledger-empty');
    row.append(aLabel, aVal);
    const note = (state.options.notes || {})[q.id];
    if(note){
      const nLabel = document.createElement('div'); nLabel.className = 'ledger-label'; nLabel.textContent = 'NOTES';
      const nVal = document.createElement('div'); nVal.className = 'ledger-note'; nVal.textContent = note;
      row.append(nLabel, nVal);
    }
    table.appendChild(row);
  });
  root.appendChild(table);
}
function renderSubmittedReceipt(root){
  const hdr = document.createElement('h2'); hdr.className = 'submitted-header'; hdr.textContent = 'Submitted';
  root.appendChild(hdr);
  const container = document.createElement('div'); container.className = 'submitted-answers';
  const table = document.createElement('div'); table.className = 'review-ledger';
  state.questions.forEach((q,i)=>{
    const row = document.createElement('div'); row.className = 'ledger-row';
    const num = document.createElement('div'); num.className = 'q-num'; num.textContent = (i+1) + '. ' + q.header;
    row.appendChild(num);
    const qLabel = document.createElement('div'); qLabel.className = 'ledger-label'; qLabel.textContent = 'QUESTION';
    const qVal = document.createElement('div'); qVal.className = 'ledger-value'; qVal.textContent = q.question;
    row.append(qLabel, qVal);
    const aLabel = document.createElement('div'); aLabel.className = 'ledger-label'; aLabel.textContent = 'ANSWER';
    const aVal = document.createElement('div'); aVal.className = 'ledger-answer';
    const ans = displayAnswerValue(currentAnswer(i));
    aVal.textContent = ans;
    if(ans === 'unanswered') aVal.classList.add('ledger-empty');
    row.append(aLabel, aVal);
    const note = (state.options.notes || {})[q.id];
    if(note){
      const nLabel = document.createElement('div'); nLabel.className = 'ledger-label'; nLabel.textContent = 'NOTES';
      const nVal = document.createElement('div'); nVal.className = 'ledger-note'; nVal.textContent = note;
      row.append(nLabel, nVal);
    }
    table.appendChild(row);
  });
  container.appendChild(table);
  root.appendChild(container);
}
function renderSubmittedTerminal(root){
  renderSubmittedReceipt(root);
  const controls = document.createElement('div');
  controls.className = 'terminal-actions';
  const timer = document.createElement('span');
  timer.id = 'auto-close-timer';
  timer.className = 'timer';
  timer.textContent = autoCloseTimerText();
  const closeNow = document.createElement('button');
  closeNow.className = 'primary-btn';
  closeNow.type = 'button';
  closeNow.textContent = 'Close Now';
  closeNow.onclick = closeBrowserTab;
  const cancel = document.createElement('button');
  cancel.id = 'cancel-auto-close';
  cancel.type = 'button';
  cancel.textContent = 'Cancel timer';
  cancel.disabled = autoCloseCancelled;
  cancel.onclick = cancelAutoCloseTimer;
  controls.append(timer, closeNow, cancel);
  root.appendChild(controls);
  startAutoCloseTimer();
}
function renderTerminal(root){
  setActionsVisible(false);
  if(state.lifecycle === 'submitted') renderSubmittedTerminal(root);
  else { stopAutoCloseTimer(); const p = document.createElement('p'); p.className = 'terminal-text'; p.textContent = terminalText(); root.appendChild(p); }
}
function render(){
  const focus = captureFocus();
  const root = document.getElementById('questions'); root.innerHTML = ''; root.textContent = '';
  updateLifecycleOverlay();
  renderProgress();
  updateLayoutMode();
  if(terminalLifecycle || state.lifecycle !== 'open'){
    renderTerminal(root);
    return;
  }
  setActionsVisible(true);
  updateActionLabels();
  if(isReviewTab()){
    const section = document.createElement('section');
    section.className = 'question active submit-review';
    renderReviewLedger(section);
    root.appendChild(section);
    restoreFocus(focus);
    return;
  }
  state.questions.forEach((q,i)=>{
    const section = document.createElement('section'); section.className = 'question' + (i === state.currentTab ? ' active' : '');
    const num = document.createElement('span'); num.className = 'q-number'; num.textContent = String(i+1);
    section.appendChild(num);
    const h2 = document.createElement('h2'); h2.textContent = q.header;
    const p = document.createElement('p'); p.textContent = q.question;
    section.append(h2, p);
    section.onclick = () => activateQuestion(i);
    const fieldset = document.createElement('fieldset');
    const opts = state.renderOptions[String(i)] || q.options || [];
    if(q.type === 'select_one' || q.type === 'confirm_enum'){
      opts.forEach((opt,j)=> addChoice(fieldset,q,i,opt,j,'radio'));
    } else if(q.type === 'select_many'){
      opts.forEach((opt,j)=> addChoice(fieldset,q,i,opt,j,'checkbox'));
    } else {
      const input = document.createElement(q.type === 'free_text' && q.multiline !== false ? 'textarea' : 'input');
      if(q.type === 'number') input.type = 'number'; else if(input.tagName === 'INPUT') input.type = 'text';
      if(q.min !== undefined) input.min = q.min; if(q.max !== undefined) input.max = q.max;
      input.placeholder = q.placeholder || '';
      input.dataset.focusKey = 'q-'+i+'-input';
      const current = currentAnswer(i); if(current !== undefined) input.value = current;
      input.onfocus = () => activateQuestion(i);
      input.oninput = () => { activateQuestion(i); const value = answerValue(q,i,input); setLocalAnswer(i,value); updateActionLabels(); sendDebounced({type:'answer', questionId:q.id, value}); };
      fieldset.appendChild(input);
    }
    section.appendChild(fieldset);
    const notesWrap = document.createElement('div'); notesWrap.className = 'notes-field';
    const notes = document.createElement('textarea'); notes.placeholder = 'Add a note...'; notes.value = (state.options.notes || {})[q.id] || '';
    notes.dataset.focusKey = 'q-'+i+'-notes';
    notes.onfocus = () => activateQuestion(i);
    notes.oninput = () => { activateQuestion(i); const next = {...(state.options.notes || {}), [q.id]: notes.value}; state.options.notes = next; sendDebounced({type:'options', options:{notes:next}}); };
    notesWrap.appendChild(notes);
    section.appendChild(notesWrap);
    root.appendChild(section);
  });
  restoreFocus(focus);
}
function addChoice(parent,q,i,opt,j,kind){
  const row = document.createElement('div'); row.className = 'choice-row' + (isChoiceChecked(q,i,opt) ? ' selected' : '');
  const input = document.createElement('input'); input.type = kind; input.name = 'q'+i; input.value = optionValue(opt); input.checked = isChoiceChecked(q,i,opt);
  input.dataset.focusKey = 'q-'+i+'-choice-'+j;
  input.onfocus = () => activateQuestion(i);
  input.onchange = () => { activateQuestion(i); if(kind === 'radio'){ parent.querySelectorAll('input[type=radio][name="'+input.name+'"]').forEach(r => { if(r!==input) r.checked=false; }); parent.querySelectorAll('.choice-row').forEach(r => r.classList.remove('selected')); row.classList.add('selected'); } else { row.classList.toggle('selected', input.checked); } const value = answerValue(q,i,input); setLocalAnswer(i,value); updateActionLabels(); send({type:'answer', questionId:q.id, value}); };
  const labelText = document.createElement('span'); labelText.className = 'label-text'; labelText.textContent = opt.label;
  row.append(input, labelText);
  row.onclick = (e) => { if(e.target.tagName==='INPUT'||isTextCtrl(e.target)||e.target.tagName==='BUTTON') return; activateQuestion(i); if(kind==='checkbox'){ input.checked=!input.checked; input.onchange(); } else if(kind==='radio'){ if(!input.checked){ input.checked=true; input.onchange(); } } };
  parent.appendChild(row);
  if(opt.description){ const d=document.createElement('div'); d.className='choice-desc'; d.textContent=opt.description; parent.appendChild(d); }
  if(opt.preview){ const key=q.id+':'+j; input.dataset.previewKey = key; const b=document.createElement('button'); b.type='button'; b.className='preview-toggle'; b.textContent=expanded.has(key)?'Hide preview':'Show preview'; b.dataset.previewKey = key; b.dataset.focusKey = 'q-'+i+'-preview-'+j; b.onclick=()=>{ activateQuestion(i); expanded.has(key)?expanded.delete(key):expanded.add(key); render();}; parent.appendChild(b); if(expanded.has(key)) renderPreview(parent,opt.preview); }
  if(opt.isOther){ const otherWrap = document.createElement('div'); otherWrap.className = 'choice-other-input'; const other=document.createElement('input'); other.id=otherInputId(q,i); other.type='text'; other.placeholder='Other'; other.value = otherAnswerText(i); other.dataset.focusKey = 'q-'+i+'-other'; other.dataset.inputRole = 'other'; other.onfocus=()=>activateQuestion(i); other.oninput=()=>{ activateQuestion(i); if(kind === 'radio' || other.value) input.checked = true; const value = answerValue(q,i,other); setLocalAnswer(i,value); updateActionLabels(); sendDebounced({type:'answer', questionId:q.id, value}); row.classList.toggle('selected', !!other.value); }; otherWrap.appendChild(other); parent.appendChild(otherWrap); }
}
function renderPreview(parent,preview){
  const box=document.createElement('div'); box.className='preview preview-'+preview.type;
  if(preview.type === 'html' || preview.type === 'svg'){
    const iframe=document.createElement('iframe'); iframe.sandbox=''; iframe.style.width='100%'; iframe.style.minHeight='140px'; iframe.srcdoc=preview.type === 'svg' ? preview.content : preview.content; box.appendChild(iframe);
  } else if(preview.type === 'markdown'){
    box.innerHTML = renderMarkdown(preview.content);
  } else if(preview.type === 'code'){
    const pre=document.createElement('pre'); const code=document.createElement('code'); code.textContent=preview.content; pre.appendChild(code); box.appendChild(pre);
  } else {
    const pre=document.createElement('pre'); pre.textContent='['+preview.type+']\\n'+preview.content; box.appendChild(pre);
  }
  parent.appendChild(box);
}
function renderMarkdown(markdown){
  return escapeHtml(markdown)
    .replace(/^### (.*)$/gm,'<h3>$1</h3>')
    .replace(/^## (.*)$/gm,'<h2>$1</h2>')
    .replace(/^# (.*)$/gm,'<h1>$1</h1>')
    .replace(/\\*\\*(.*?)\\*\\*/g,'<strong>$1</strong>')
    .replace(new RegExp(String.fromCharCode(96)+'([^'+String.fromCharCode(96)+']+)'+String.fromCharCode(96),'g'),'<code>$1</code>')
    .replace(/\\n/g,'<br>');
}
document.addEventListener('keydown', event => { if(event.key === 'e'){ const key = document.activeElement?.dataset?.previewKey || firstPreviewKeyForCurrentQuestion(); if(key){ expanded.has(key)?expanded.delete(key):expanded.add(key); render(); } } });
function firstPreviewKeyForCurrentQuestion(){ const q=state.questions[state.currentTab]; if(!q) return null; const opts=state.renderOptions[String(state.currentTab)] || q.options || []; const idx=opts.findIndex(opt=>opt.preview); return idx === -1 ? null : q.id+':'+idx; }

/* === Theme Toggle === */
const THEME_KEY='pq-theme';
const themes=[{id:'auto',label:'System',icon:'\u25CC'},{id:'light',label:'Light',icon:'\u2600'},{id:'dark',label:'Dark',icon:'\u263E'}];
let themeIdx=0;
function themeRoot(){ return document.documentElement || document.body; }
function effectiveTheme(theme){ return theme === 'auto' ? (mediaQuery.matches ? 'dark' : 'light') : theme; }
function applyTheme(theme){ themeRoot().dataset.theme=effectiveTheme(theme); if(typeof localStorage!=='undefined') localStorage.setItem(THEME_KEY,theme); if(theme==='auto'){ mediaQuery.onchange=()=>{ if((localStorage.getItem(THEME_KEY)||'auto')==='auto') themeRoot().dataset.theme=effectiveTheme('auto'); }; } else { mediaQuery.onchange=null; } }
function toggleTheme(){ themeIdx=(themeIdx+1)%themes.length; applyTheme(themes[themeIdx].id); renderThemeBtn(); }
function renderThemeBtn(){ const btn=document.getElementById('theme-toggle'); if(!btn)return; const t=themes[themeIdx]; btn.textContent=t.icon+' '+t.label; btn.title='Theme: '+t.label+' (click to cycle)'; }
function renderLayoutBtn(){ const btn=document.getElementById('layout-toggle'); if(!btn)return; btn.textContent=isSingleMode()?'One Q':'All Qs'; btn.title='Layout: '+(isSingleMode()?'One question at a time':'All questions'); }
const mediaQuery=(typeof window!=='undefined'&&window.matchMedia)?window.matchMedia('(prefers-color-scheme:dark)'):{matches:false,onchange:null};
const savedTheme=(typeof localStorage!=='undefined'&&localStorage.getItem(THEME_KEY))||'auto';
themeIdx=themes.findIndex(t=>t.id===savedTheme);
if(themeIdx===-1)themeIdx=0;
applyTheme(themes[themeIdx].id);

/* === Layout Mode === */
const LAYOUT_KEY='pq-layout';
let layoutMode=(typeof localStorage!=='undefined'&&localStorage.getItem(LAYOUT_KEY))||'all';
function isSingleMode(){ return layoutMode==='single'; }
function updateLayoutMode(){ const wrapper=document.getElementById('mode-wrapper'); const reviewing=isReviewTab() || terminalLifecycle || state.lifecycle !== 'open'; if(wrapper){ wrapper.classList.toggle('single-question-mode',isSingleMode()); wrapper.classList.toggle('review-mode',reviewing); } const backNext=document.getElementById('back-next'); if(backNext) backNext.style.display=isSingleMode() && !reviewing ? '' : 'none'; const backBtn=document.getElementById('back-btn'); const nextBtn=document.getElementById('next-btn'); if(backBtn) backBtn.disabled=(state.currentTab===0); if(nextBtn){ const isLastQ=(state.currentTab>=state.questions.length-1); nextBtn.textContent=isLastQ?'Review':'Next'; } }
function toggleLayout(){ layoutMode=layoutMode==='all'?'single':'all'; if(typeof localStorage!=='undefined') localStorage.setItem(LAYOUT_KEY,layoutMode); renderLayoutBtn(); render(); }
function goBack(){ if(state.currentTab>0) setTab(state.currentTab-1); render(); }
function goNext(){ if(isReviewTab()){ confirmSubmit(); return; } if(state.currentTab<state.questions.length-1) setTab(state.currentTab+1); else showSubmitReview(); render(); }
function isTextCtrl(el){ if(!el)return false; if(el.tagName==='TEXTAREA')return true; if(el.tagName!=='INPUT')return false; return ['text','number','search','email','url','tel','password'].includes(el.type||'text'); }
renderThemeBtn();
renderLayoutBtn();
document.getElementById('submit').onclick = () => { if(isReviewTab()) confirmSubmit(); else if(state.questions.length >= 2) showSubmitReview(); else confirmSubmit(); };
document.getElementById('review-back').onclick = () => { returnFromSubmitReview(); };
document.getElementById('back-btn').onclick = () => { goBack(); };
document.getElementById('next-btn').onclick = () => { goNext(); };
document.getElementById('theme-toggle').onclick = () => { toggleTheme(); };
document.getElementById('layout-toggle').onclick = () => { toggleLayout(); };
document.addEventListener('keydown', event => { if(event.key==='Enter' && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey && isSingleMode() && !isReviewTab() && isTextCtrl(document.activeElement)){ event.preventDefault(); goNext(); } });
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
connect(); render(); setInterval(()=>send({type:'ping'}), 25000);