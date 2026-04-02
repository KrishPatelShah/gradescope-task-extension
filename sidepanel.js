const FILTERS = [
  "All",
  "Due Today",
  "Due Tomorrow",
  "Due This Week",
  "Overdue",
  "No Due Date"
];

const GROUP_ORDER = [
  "Overdue",
  "Due Today",
  "Due Tomorrow",
  "Due This Week",
  "Later",
  "No Due Date"
];

const state = {
  cache: null,
  assignments: [],
  loading: false,
  progressText: "",
  query: "",
  courseFilter: "all",
  activeFilter: "All",
  selectedDate: null,
  visibleMonth: startOfMonth(new Date())
};

const elements = {
  refreshButton: document.getElementById("refreshButton"),
  banner: document.getElementById("banner"),
  lastUpdatedText: document.getElementById("lastUpdatedText"),
  summaryText: document.getElementById("summaryText"),
  calendarMonthLabel: document.getElementById("calendarMonthLabel"),
  calendarWeekdays: document.getElementById("calendarWeekdays"),
  calendarGrid: document.getElementById("calendarGrid"),
  selectedDateText: document.getElementById("selectedDateText"),
  clearDateButton: document.getElementById("clearDateButton"),
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

  elements.todayButton.addEventListener("click", () => {
    const today = new Date();
    state.visibleMonth = startOfMonth(today);
    state.selectedDate = formatDayKey(today);
    render();
  });

  elements.prevMonthButton.addEventListener("click", () => {
    state.visibleMonth = new Date(state.visibleMonth.getFullYear(), state.visibleMonth.getMonth() - 1, 1);
    renderCalendar();
  });

  elements.nextMonthButton.addEventListener("click", () => {
    state.visibleMonth = new Date(state.visibleMonth.getFullYear(), state.visibleMonth.getMonth() + 1, 1);
    renderCalendar();
  });

  elements.clearDateButton.addEventListener("click", () => {
    state.selectedDate = null;
    render();
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
    render();
  });

  elements.assignmentSections.addEventListener("click", (event) => {
    const card = event.target.closest("[data-url]");
    if (!card) {
      return;
    }

    openAssignment(card.dataset.url);
  });

  elements.assignmentSections.addEventListener("keydown", (event) => {
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
    const firstAssignmentWithDate = state.assignments.find((assignment) => assignment.dueAt);
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

  renderStateArea();
  updateTopMeta();
}

async function startRefresh(reason) {
  state.loading = true;
  state.progressText = "Starting refresh...";
  renderBanner();
  renderStateArea();

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
    renderStateArea();
  }
}

async function openAssignment(url) {
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
  updateTopMeta();
  renderBanner();
  renderCalendar();
  renderFilterChips();
  renderStateArea();
  renderAssignments();
}

function updateTopMeta() {
  const summary = state.cache && state.cache.summary ? state.cache.summary : null;
  const totalAssignments = summary ? summary.totalAssignments : state.assignments.length;
  const courseCount = summary ? summary.courseCount : new Set(state.assignments.map((assignment) => assignment.courseName)).size;

  elements.lastUpdatedText.textContent = state.cache && state.cache.updatedAt
    ? `Last updated: ${formatTimestamp(state.cache.updatedAt)}`
    : "Last updated: Never";

  elements.summaryText.textContent = `${totalAssignments} assignment${totalAssignments === 1 ? "" : "s"} across ${courseCount} course${courseCount === 1 ? "" : "s"}`;
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

function renderCalendar() {
  const monthStart = startOfMonth(state.visibleMonth);
  const monthEnd = endOfMonth(state.visibleMonth);
  const gridStart = new Date(monthStart);
  gridStart.setDate(monthStart.getDate() - monthStart.getDay());
  const gridEnd = new Date(monthEnd);
  gridEnd.setDate(monthEnd.getDate() + (6 - monthEnd.getDay()));

  const dayButtons = [];
  const calendarAssignments = getCalendarAssignments();
  const counts = countAssignmentsByDay(calendarAssignments);
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

  if (state.selectedDate) {
    elements.selectedDateText.textContent = `Filtering to ${formatDayLabel(state.selectedDate)}`;
    elements.clearDateButton.classList.remove("hidden");
  } else {
    elements.selectedDateText.textContent = "Showing all dates";
    elements.clearDateButton.classList.add("hidden");
  }
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
  const courseNames = Array.from(new Set(state.assignments.map((assignment) => assignment.courseName))).sort((left, right) => left.localeCompare(right));

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

function renderStateArea() {
  if (state.loading && !state.assignments.length) {
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
    elements.stateArea.innerHTML = `
      <div class="panel-card state-card">
        <h3>No cached assignments yet</h3>
        <p>Open Gradescope while signed in, then press Refresh to scan your course assignment pages and build the dashboard.</p>
      </div>
    `;
    return;
  }

  elements.stateArea.innerHTML = "";
}

function renderAssignments() {
  const visibleAssignments = getVisibleAssignments();

  if (!state.assignments.length) {
    elements.assignmentSections.innerHTML = "";
    return;
  }

  if (!visibleAssignments.length) {
    elements.assignmentSections.innerHTML = `
      <div class="panel-card state-card">
        <h3>No assignments match these filters</h3>
        <p>Try clearing the date filter, switching the chip selection, or broadening the search.</p>
      </div>
    `;
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
  const urgencyClass = urgencyToClass(getUrgencyLabel(assignment));
  const statusMarkup = assignment.status ? `<span class="status-pill">${escapeHtml(assignment.status)}</span>` : "";
  const pointsMarkup = assignment.points ? `<span class="points-pill">${escapeHtml(assignment.points)}</span>` : "";
  const humanDueLabel = getAssignmentDueLabel(assignment);
  const secondaryLine = assignment.timestampText && assignment.timestampText !== assignment.dueLabel
    ? `<p class="assignment-secondary">${escapeHtml(assignment.timestampText)}</p>`
    : "";

  return `
    <article class="assignment-card ${urgencyClass}" tabindex="0" data-url="${escapeAttribute(assignment.url)}">
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
        <span class="group-subtitle">${escapeHtml(assignment.url.replace("https://www.gradescope.com", "gradescope.com"))}</span>
        <button class="assignment-open-button" type="button">Open</button>
      </div>
    </article>
  `;
}

function getVisibleAssignments() {
  return state.assignments.filter((assignment) => {
    if (state.courseFilter !== "all" && assignment.courseName !== state.courseFilter) {
      return false;
    }

    if (state.query) {
      const haystack = [
        assignment.title,
        assignment.courseName,
        assignment.status,
        assignment.points,
        assignment.dueLabel,
        assignment.timestampText
      ].filter(Boolean).join(" ").toLowerCase();

      if (!haystack.includes(state.query)) {
        return false;
      }
    }

    if (!matchesFilterChip(assignment, state.activeFilter)) {
      return false;
    }

    if (state.selectedDate && formatDayKeyFromAssignment(assignment) !== state.selectedDate) {
      return false;
    }

    return true;
  });
}

function getCalendarAssignments() {
  return state.assignments.filter((assignment) => {
    if (state.courseFilter !== "all" && assignment.courseName !== state.courseFilter) {
      return false;
    }

    if (!state.query) {
      return true;
    }

    const haystack = [assignment.title, assignment.courseName, assignment.dueLabel].filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(state.query);
  });
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
    "Overdue": "Past due items that still need attention.",
    "Due Today": "Assignments closing before the day ends.",
    "Due Tomorrow": "The next set of deadlines coming up.",
    "Due This Week": "Remaining due dates before this week wraps up.",
    "Later": "Upcoming work scheduled after this week.",
    "No Due Date": "Assignments without a visible due date on Gradescope."
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
