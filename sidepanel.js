const FILTERS = [
  "All",
  "Overdue",
  "Due Today",
  "Due Tomorrow",
  "Due This Week",
  "Later",
  "No Due Date"
];

const GROUP_ORDER = [
  "Due Today",
  "Due Tomorrow",
  "Due This Week",
  "Later",
  "Overdue",
  "No Due Date"
];

const COMPLETED_STATUSES = new Set([
  "Submitted",
  "Graded",
  "Released"
]);

const state = {
  cache: null,
  assignments: [],
  loading: false,
  progressText: "",
  query: "",
  courseFilter: "all",
  activeFilter: "All",
  activeTab: "todo",
  selectedDate: null,
  visibleMonth: startOfMonth(new Date())
};

const elements = {
  refreshButton: document.getElementById("refreshButton"),
  banner: document.getElementById("banner"),
  lastUpdatedText: document.getElementById("lastUpdatedText"),
  summaryText: document.getElementById("summaryText"),
  tabButtons: Array.from(document.querySelectorAll("[data-tab-button]")),
  todoPanel: document.getElementById("todoPanel"),
  calendarPanel: document.getElementById("calendarPanel"),
  calendarCard: document.querySelector(".calendar-card"),
  calendarStateArea: document.getElementById("calendarStateArea"),
  calendarMonthLabel: document.getElementById("calendarMonthLabel"),
  calendarWeekdays: document.getElementById("calendarWeekdays"),
  calendarGrid: document.getElementById("calendarGrid"),
  selectedDateText: document.getElementById("selectedDateText"),
  clearDateButton: document.getElementById("clearDateButton"),
  calendarAssignmentsArea: document.getElementById("calendarAssignmentsArea"),
  todayButton: document.getElementById("todayButton"),
  prevMonthButton: document.getElementById("prevMonthButton"),
  nextMonthButton: document.getElementById("nextMonthButton"),
  searchInput: document.getElementById("searchInput"),
  courseFilter: document.getElementById("courseFilter"),
  filterChips: document.getElementById("filterChips"),
  stateArea: document.getElementById("stateArea"),
  assignmentSections: document.getElementById("assignmentSections")
};

initialize();

function initialize() {
  renderWeekdays();
  renderFilterChips();
  attachEventListeners();
  loadInitialState();

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || !message.type) {
      return;
    }

    if (message.type === "REFRESH_STATUS") {
      handleRefreshStatus(message.refreshState);
    }

    if (message.type === "CACHE_UPDATED") {
      state.cache = message.cache || null;
      applyCacheToState();
      render();
    }
  });
}

function attachEventListeners() {
  elements.refreshButton.addEventListener("click", () => {
    startRefresh("manual");
  });

  elements.tabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.activeTab = button.dataset.tabButton;
      renderTabs();
    });
  });

  elements.todayButton.addEventListener("click", () => {
    const today = new Date();
    state.visibleMonth = startOfMonth(today);
    state.selectedDate = formatDayKey(today);
    renderCalendarPanel();
  });

  elements.prevMonthButton.addEventListener("click", () => {
    state.visibleMonth = new Date(state.visibleMonth.getFullYear(), state.visibleMonth.getMonth() - 1, 1);
    renderCalendarPanel();
  });

  elements.nextMonthButton.addEventListener("click", () => {
    state.visibleMonth = new Date(state.visibleMonth.getFullYear(), state.visibleMonth.getMonth() + 1, 1);
    renderCalendarPanel();
  });

  elements.clearDateButton.addEventListener("click", () => {
    state.selectedDate = null;
    renderCalendarPanel();
  });

  elements.searchInput.addEventListener("input", (event) => {
    state.query = event.target.value.trim().toLowerCase();
    render();
  });

  elements.courseFilter.addEventListener("change", (event) => {
    state.courseFilter = event.target.value;
    render();
  });

  elements.filterChips.addEventListener("click", (event) => {
    const button = event.target.closest("[data-filter]");
    if (!button) {
      return;
    }

    state.activeFilter = button.dataset.filter;
    render();
  });

  elements.calendarGrid.addEventListener("click", (event) => {
    const button = event.target.closest("[data-day]");
    if (!button) {
      return;
    }

    state.selectedDate = button.dataset.day;
    renderCalendarPanel();
  });

  attachAssignmentOpenHandlers(elements.assignmentSections);
  attachAssignmentOpenHandlers(elements.calendarAssignmentsArea);
}

async function loadInitialState() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_CACHE" });
    if (response && response.ok) {
      state.cache = response.cache || null;
      state.loading = Boolean(response.refreshState && response.refreshState.running);
      state.progressText = response.refreshState ? response.refreshState.progress : "";
      applyCacheToState();
      render();
    }
  } catch (error) {
    showBanner("Unable to load cached Gradescope data.", "error");
  }

  try {
    await chrome.runtime.sendMessage({ type: "PANEL_OPENED" });
  } catch (error) {
    // If the service worker is cold, GET_CACHE usually wakes it first.
  }
}

function applyCacheToState() {
  state.assignments = Array.isArray(state.cache && state.cache.assignments) ? state.cache.assignments : [];

  if (!state.selectedDate) {
    const firstUpcomingAssignment = getUpcomingAssignments()[0];
    const firstTodoAssignmentWithDate = getTodoAssignments().find((assignment) => assignment.dueAt);
    const firstCalendarAssignment = getCalendarBaseAssignments()[0];
    const firstAssignmentWithDate = firstUpcomingAssignment || firstTodoAssignmentWithDate || firstCalendarAssignment || state.assignments.find((assignment) => assignment.dueAt);
    state.visibleMonth = startOfMonth(firstAssignmentWithDate ? new Date(firstAssignmentWithDate.dueAt) : new Date());
  }

  populateCourseFilter();
}

function handleRefreshStatus(refreshState) {
  state.loading = Boolean(refreshState && refreshState.running);
  state.progressText = refreshState ? refreshState.progress : "";

  if (refreshState && refreshState.lastError) {
    showBanner(refreshState.lastError, "error");
  } else {
    renderBanner();
  }

  renderTodoPanel();
  renderCalendarPanel();
  updateTopMeta();
}

async function startRefresh(reason) {
  state.loading = true;
  state.progressText = "Starting refresh...";
  renderBanner();
  renderTodoPanel();
  renderCalendarPanel();

  try {
    const response = await chrome.runtime.sendMessage({
      type: "START_REFRESH",
      reason
    });

    if (!response || !response.ok) {
      throw new Error(response && response.error ? response.error : "Refresh failed.");
    }
  } catch (error) {
    state.loading = false;
    showBanner(error.message || "Unable to refresh Gradescope data.", "error");
    renderTodoPanel();
    renderCalendarPanel();
  }
}

async function openAssignment(url) {
  if (!url) {
    return;
  }

  try {
    await chrome.runtime.sendMessage({
      type: "OPEN_ASSIGNMENT",
      url
    });
  } catch (error) {
    showBanner("Unable to open that Gradescope assignment.", "error");
  }
}

function render() {
  renderTabs();
  updateTopMeta();
  renderBanner();
  renderFilterChips();
  renderTodoPanel();
  renderCalendarPanel();
}

function renderTabs() {
  elements.tabButtons.forEach((button) => {
    const isActive = button.dataset.tabButton === state.activeTab;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-selected", String(isActive));
  });

  elements.todoPanel.classList.toggle("hidden", state.activeTab !== "todo");
  elements.calendarPanel.classList.toggle("hidden", state.activeTab !== "calendar");
}

function updateTopMeta() {
  const todoAssignments = getTodoAssignments();
  const upcomingAssignments = getUpcomingAssignments();
  const courseCount = new Set(todoAssignments.map((assignment) => assignment.courseName)).size;

  elements.lastUpdatedText.textContent = state.cache && state.cache.updatedAt
    ? `Last updated: ${formatTimestamp(state.cache.updatedAt)}`
    : "Last updated: Never";

  elements.summaryText.textContent = `${todoAssignments.length} todo item${todoAssignments.length === 1 ? "" : "s"} across ${courseCount} course${courseCount === 1 ? "" : "s"} · ${upcomingAssignments.length} upcoming`;
}

function renderBanner() {
  if (state.loading) {
    showBanner(state.progressText || "Refreshing Gradescope assignments...", "info");
    return;
  }

  if (state.cache && state.cache.lastError) {
    showBanner(state.cache.lastError, "error");
    return;
  }

  if (state.cache && state.cache.partial && Array.isArray(state.cache.errors) && state.cache.errors.length) {
    const failedCount = state.cache.errors.length;
    showBanner(`${failedCount} course${failedCount === 1 ? "" : "s"} could not be parsed this time. The rest of your assignments are still shown.`, "warning");
    return;
  }

  elements.banner.className = "banner hidden";
  elements.banner.textContent = "";
}

function showBanner(text, tone) {
  elements.banner.className = `banner banner-${tone}`;
  elements.banner.textContent = text;
}

function renderWeekdays() {
  const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  elements.calendarWeekdays.innerHTML = weekdayNames.map((day) => `<div class="calendar-weekday">${day}</div>`).join("");
}

function renderCalendarPanel() {
  const calendarBaseAssignments = getCalendarBaseAssignments();

  if (!state.assignments.length) {
    elements.calendarCard.classList.add("hidden");
    elements.calendarStateArea.innerHTML = renderStateCard(
      "No cached assignments yet",
      "Open Gradescope while signed in, then press Refresh to scan your course assignment pages and build the planner."
    );
    return;
  }

  if (!calendarBaseAssignments.length) {
    elements.calendarCard.classList.add("hidden");
    elements.calendarStateArea.innerHTML = renderStateCard(
      "No dated assignments",
      "Gradescope has not exposed any assignments with due dates yet, so there is nothing to place on the calendar."
    );
    return;
  }

  elements.calendarCard.classList.remove("hidden");
  elements.calendarStateArea.innerHTML = "";
  renderCalendar(calendarBaseAssignments);
}

function renderCalendar(assignments) {
  const monthStart = startOfMonth(state.visibleMonth);
  const monthEnd = endOfMonth(state.visibleMonth);
  const gridStart = new Date(monthStart);
  gridStart.setDate(monthStart.getDate() - monthStart.getDay());
  const gridEnd = new Date(monthEnd);
  gridEnd.setDate(monthEnd.getDate() + (6 - monthEnd.getDay()));

  const dayButtons = [];
  const counts = countAssignmentsByDay(assignments);
  const todayKey = formatDayKey(new Date());

  elements.calendarMonthLabel.textContent = monthStart.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric"
  });

  for (let current = new Date(gridStart); current <= gridEnd; current.setDate(current.getDate() + 1)) {
    const day = new Date(current);
    const dayKey = formatDayKey(day);
    const count = counts[dayKey] || 0;
    const classes = ["calendar-day"];

    if (day.getMonth() !== monthStart.getMonth()) {
      classes.push("is-other-month");
    }

    if (dayKey === todayKey) {
      classes.push("is-today");
    }

    if (state.selectedDate === dayKey) {
      classes.push("is-selected");
    }

    dayButtons.push(`
      <button class="${classes.join(" ")}" type="button" data-day="${dayKey}">
        <span>${day.getDate()}</span>
        ${count > 1 ? `<span class="calendar-day-count">${count}</span>` : count === 1 ? "<span class='calendar-day-dot'></span>" : ""}
      </button>
    `);
  }

  elements.calendarGrid.innerHTML = dayButtons.join("");
  renderCalendarSummary(assignments);
  renderCalendarAssignments(assignments);
}

function renderCalendarSummary(assignments) {
  if (state.selectedDate) {
    const count = assignments.filter((assignment) => formatDayKeyFromAssignment(assignment) === state.selectedDate).length;
    elements.selectedDateText.textContent = `${count} assignment${count === 1 ? "" : "s"} due on ${formatDayLabel(state.selectedDate)}`;
    elements.clearDateButton.classList.remove("hidden");
    return;
  }

  elements.selectedDateText.textContent = `Showing ${assignments.length} dated assignment${assignments.length === 1 ? "" : "s"}`;
  elements.clearDateButton.classList.add("hidden");
}

function renderCalendarAssignments(assignments) {
  if (!state.selectedDate) {
    elements.calendarAssignmentsArea.innerHTML = renderCalendarHint(
      "Select a date to see which assignments are due that day."
    );
    return;
  }

  const selectedAssignments = getCalendarAssignments()
    .sort(compareAssignmentsForRender);

  if (!selectedAssignments.length) {
    elements.calendarAssignmentsArea.innerHTML = renderCalendarHint(
      `No assignments are due on ${formatDayLabel(state.selectedDate)}.`
    );
    return;
  }

  elements.calendarAssignmentsArea.innerHTML = `
    <div class="calendar-assignments-header">
      <h3 class="calendar-assignments-title">${escapeHtml(formatDayLabel(state.selectedDate))}</h3>
      <span class="group-subtitle">${selectedAssignments.length} assignment${selectedAssignments.length === 1 ? "" : "s"}</span>
    </div>
    <div class="assignment-list">
      ${selectedAssignments.map(renderAssignmentCard).join("")}
    </div>
  `;
}

function renderFilterChips() {
  elements.filterChips.innerHTML = FILTERS.map((filterName) => `
    <button
      class="chip-button ${state.activeFilter === filterName ? "is-active" : ""}"
      type="button"
      data-filter="${filterName}">
      ${filterName}
    </button>
  `).join("");
}

function populateCourseFilter() {
  const currentValue = state.courseFilter;
  const courseNames = Array.from(new Set(getTodoAssignments().map((assignment) => assignment.courseName))).sort((left, right) => left.localeCompare(right));

  elements.courseFilter.innerHTML = [
    '<option value="all">All courses</option>',
    ...courseNames.map((courseName) => `<option value="${escapeHtml(courseName)}">${escapeHtml(courseName)}</option>`)
  ].join("");

  if (courseNames.includes(currentValue)) {
    elements.courseFilter.value = currentValue;
  } else {
    state.courseFilter = "all";
    elements.courseFilter.value = "all";
  }
}

function renderTodoPanel() {
  renderStateArea();
  renderAssignments();
}

function renderStateArea() {
  const todoAssignments = getTodoAssignments();

  if (state.loading && !todoAssignments.length) {
    elements.stateArea.innerHTML = `
      <div class="panel-card state-card is-loading">
        <h3>Gathering your Gradescope assignments</h3>
        <p>${escapeHtml(state.progressText || "Opening course pages and collecting due dates...")}</p>
        <div class="loading-bar"></div>
      </div>
    `;
    return;
  }

  if (!state.assignments.length) {
    elements.stateArea.innerHTML = renderStateCard(
      "No cached assignments yet",
      "Open Gradescope while signed in, then press Refresh to scan your course assignment pages and build the planner."
    );
    return;
  }

  if (!todoAssignments.length) {
    elements.stateArea.innerHTML = renderStateCard(
      "No todo items",
      "Your Gradescope assignments currently look complete, so there is nothing left in the Todo view right now."
    );
    return;
  }

  elements.stateArea.innerHTML = "";
}

function renderAssignments() {
  const todoAssignments = getTodoAssignments();
  const visibleAssignments = getVisibleAssignments();

  if (!todoAssignments.length) {
    elements.assignmentSections.innerHTML = "";
    return;
  }

  if (!visibleAssignments.length) {
    elements.assignmentSections.innerHTML = renderStateCard(
      "No assignments match these filters",
      "Try clearing the search, switching the course filter, or choosing a different chip."
    );
    return;
  }

  const groupedAssignments = buildAssignmentGroups(visibleAssignments);
  const sections = GROUP_ORDER.map((groupName) => groupedAssignments[groupName]).filter(Boolean);

  elements.assignmentSections.innerHTML = sections.map((group) => `
    <section class="panel-card assignment-group">
      <div class="group-header">
        <div>
          <div class="group-title-wrap">
            <span class="group-count">${group.items.length}</span>
            <h3>${group.name}</h3>
          </div>
          <p class="group-subtitle">${escapeHtml(group.subtitle)}</p>
        </div>
      </div>
      <div class="assignment-list">
        ${group.items.map(renderAssignmentCard).join("")}
      </div>
    </section>
  `).join("");
}

function renderAssignmentCard(assignment) {
  const canOpen = Boolean(assignment.url);
  const urgencyClass = urgencyToClass(getUrgencyLabel(assignment));
  const statusMarkup = assignment.status ? `<span class="status-pill">${escapeHtml(assignment.status)}</span>` : "";
  const pointsMarkup = assignment.points ? `<span class="points-pill">${escapeHtml(assignment.points)}</span>` : "";
  const humanDueLabel = getAssignmentDueLabel(assignment);
  const secondaryLine = assignment.timestampText && assignment.timestampText !== assignment.dueLabel
    ? `<p class="assignment-secondary">${escapeHtml(assignment.timestampText)}</p>`
    : "";
  const locationText = canOpen
    ? escapeHtml(assignment.url.replace("https://www.gradescope.com", "gradescope.com"))
    : "No direct link available";
  const actionMarkup = canOpen
    ? '<button class="assignment-open-button" type="button">Open</button>'
    : '<button class="assignment-open-button" type="button" disabled>Unavailable</button>';
  const tabIndex = canOpen ? "0" : "-1";
  const urlAttribute = canOpen ? ` data-url="${escapeAttribute(assignment.url)}"` : "";

  return `
    <article class="assignment-card ${urgencyClass}" tabindex="${tabIndex}"${urlAttribute}>
      <div class="assignment-card-top">
        <span class="course-pill">${escapeHtml(assignment.courseName || "Unknown Course")}</span>
        <div class="assignment-badges">
          ${statusMarkup}
          ${pointsMarkup}
        </div>
      </div>
      <h4 class="assignment-title">${escapeHtml(assignment.title)}</h4>
      <p class="assignment-meta">${escapeHtml(humanDueLabel)}</p>
      ${secondaryLine}
      <div class="assignment-card-bottom">
        <span class="group-subtitle">${locationText}</span>
        ${actionMarkup}
      </div>
    </article>
  `;
}

function getVisibleAssignments() {
  return getAssignmentsMatchingControls(getTodoAssignments()).filter((assignment) => matchesFilterChip(assignment, state.activeFilter));
}

function getCalendarAssignments() {
  return getCalendarBaseAssignments().filter((assignment) => {
    if (state.selectedDate && formatDayKeyFromAssignment(assignment) !== state.selectedDate) {
      return false;
    }

    return true;
  });
}

function getAssignmentsMatchingControls(assignments) {
  return assignments.filter((assignment) => {
    if (state.courseFilter !== "all" && assignment.courseName !== state.courseFilter) {
      return false;
    }

    if (state.query && !matchesQuery(assignment, state.query)) {
      return false;
    }

    return true;
  });
}

function getTodoAssignments() {
  return state.assignments.filter((assignment) => {
    if (isAssignmentCompleted(assignment)) {
      return false;
    }

    return true;
  });
}

function getUpcomingAssignments() {
  return getTodoAssignments().filter((assignment) => {
    if (!assignment.dueAt) {
      return false;
    }

    return new Date(assignment.dueAt) >= startOfDay(new Date());
  });
}

function getCalendarBaseAssignments() {
  return state.assignments.filter((assignment) => Boolean(assignment.dueAt));
}

function isAssignmentCompleted(assignment) {
  return COMPLETED_STATUSES.has(String(assignment.status || "").trim());
}

function matchesQuery(assignment, query) {
  const haystack = [
    assignment.title,
    assignment.courseName,
    assignment.status,
    assignment.points,
    assignment.dueLabel,
    assignment.timestampText
  ].filter(Boolean).join(" ").toLowerCase();

  return haystack.includes(query);
}

function countAssignmentsByDay(assignments) {
  const counts = {};

  for (const assignment of assignments) {
    const dayKey = formatDayKeyFromAssignment(assignment);
    if (!dayKey) {
      continue;
    }

    counts[dayKey] = (counts[dayKey] || 0) + 1;
  }

  return counts;
}

function compareAssignmentsForRender(left, right) {
  if (!left.dueAt && !right.dueAt) {
    return left.title.localeCompare(right.title);
  }

  if (!left.dueAt) {
    return 1;
  }

  if (!right.dueAt) {
    return -1;
  }

  const leftTime = new Date(left.dueAt).getTime();
  const rightTime = new Date(right.dueAt).getTime();

  if (leftTime === rightTime) {
    return left.title.localeCompare(right.title);
  }

  return leftTime - rightTime;
}

function buildAssignmentGroups(assignments) {
  const grouped = {};

  for (const assignment of assignments) {
    const groupName = getUrgencyLabel(assignment);
    if (!grouped[groupName]) {
      grouped[groupName] = {
        name: groupName,
        subtitle: subtitleForGroup(groupName),
        items: []
      };
    }

    grouped[groupName].items.push(assignment);
  }

  return grouped;
}

function matchesFilterChip(assignment, filterName) {
  if (filterName === "All") {
    return true;
  }

  const urgencyLabel = getUrgencyLabel(assignment);

  if (filterName === "No Due Date") {
    return urgencyLabel === "No Due Date";
  }

  if (filterName === "Overdue") {
    return urgencyLabel === "Overdue";
  }

  if (filterName === "Due This Week") {
    return urgencyLabel === "Due This Week";
  }

  return urgencyLabel === filterName;
}

function getUrgencyLabel(assignment) {
  if (!assignment.dueAt) {
    return "No Due Date";
  }

  const dueDate = new Date(assignment.dueAt);
  const todayStart = startOfDay(new Date());
  const tomorrowStart = addDays(todayStart, 1);
  const dayAfterTomorrowStart = addDays(todayStart, 2);
  const nextWeekStart = addDays(endOfWeek(todayStart), 1);

  if (dueDate < todayStart) {
    return "Overdue";
  }

  if (isSameDay(dueDate, todayStart)) {
    return "Due Today";
  }

  if (isSameDay(dueDate, tomorrowStart)) {
    return "Due Tomorrow";
  }

  if (dueDate >= dayAfterTomorrowStart && dueDate < nextWeekStart) {
    return "Due This Week";
  }

  return "Later";
}

function getAssignmentDueLabel(assignment) {
  const urgencyLabel = getUrgencyLabel(assignment);

  if (urgencyLabel === "Overdue" && assignment.dueAt) {
    return `Overdue · ${formatDateTime(assignment.dueAt)}`;
  }

  if (urgencyLabel === "Due Today") {
    return assignment.dueAt ? `Due Today · ${formatTime(assignment.dueAt)}` : "Due Today";
  }

  if (urgencyLabel === "Due Tomorrow") {
    return assignment.dueAt ? `Due Tomorrow · ${formatTime(assignment.dueAt)}` : "Due Tomorrow";
  }

  if (assignment.dueAt) {
    return `Due ${formatDateTime(assignment.dueAt)}`;
  }

  return assignment.dueLabel || "No due date listed";
}

function subtitleForGroup(groupName) {
  const subtitles = {
    "Overdue": "Incomplete work that has already passed its due date.",
    "Due Today": "Assignments that still need attention before today ends.",
    "Due Tomorrow": "The next deadlines coming up after today.",
    "Due This Week": "Open work due before this week wraps up.",
    "Later": "Upcoming assignments scheduled after this week.",
    "No Due Date": "Incomplete work without a visible due date on Gradescope."
  };

  return subtitles[groupName] || "";
}

function urgencyToClass(urgencyLabel) {
  const classes = {
    "Overdue": "is-overdue",
    "Due Today": "is-due-today",
    "Due Tomorrow": "is-due-tomorrow",
    "Due This Week": "is-due-this-week",
    "Later": "is-later",
    "No Due Date": "is-no-due-date"
  };

  return classes[urgencyLabel] || "";
}

function renderStateCard(title, body) {
  return `
    <div class="panel-card state-card">
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(body)}</p>
    </div>
  `;
}

function renderCalendarHint(body) {
  return `
    <div class="panel-card state-card">
      <p>${escapeHtml(body)}</p>
    </div>
  `;
}

function formatTimestamp(isoString) {
  return new Date(isoString).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function formatDateTime(isoString) {
  return new Date(isoString).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function formatTime(isoString) {
  return new Date(isoString).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit"
  });
}

function formatDayLabel(dayKey) {
  const [year, month, day] = dayKey.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric"
  });
}

function formatDayKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDayKeyFromAssignment(assignment) {
  if (!assignment.dueAt) {
    return null;
  }

  return formatDayKey(new Date(assignment.dueAt));
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function endOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function endOfWeek(date) {
  const start = startOfDay(date);
  return addDays(start, 6 - start.getDay());
}

function addDays(date, amount) {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

function isSameDay(left, right) {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

function attachAssignmentOpenHandlers(container) {
  container.addEventListener("click", (event) => {
    const card = event.target.closest("[data-url]");
    if (!card) {
      return;
    }

    openAssignment(card.dataset.url);
  });

  container.addEventListener("keydown", (event) => {
    const card = event.target.closest("[data-url]");
    if (!card) {
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openAssignment(card.dataset.url);
    }
  });
}
