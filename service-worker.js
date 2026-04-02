const GRADESCOPE_ORIGIN = "https://www.gradescope.com";
const DASHBOARD_URL = `${GRADESCOPE_ORIGIN}/`;
const CACHE_KEY = "gradescopeDashboardCache";
const AUTO_REFRESH_MAX_AGE_MS = 60 * 60 * 1000;
const AUTO_REFRESH_COOLDOWN_MS = 60 * 1000;
const SCRAPE_WAIT_MS = 350;
const TAB_TIMEOUT_MS = 30000;

const scrapeTabIds = new Set();

let lastVisitRefreshAt = 0;
let refreshState = {
  running: false,
  startedAt: null,
  reason: null,
  progress: "Idle",
  currentCourse: null,
  completedCourses: 0,
  totalCourses: 0,
  lastError: null
};

chrome.runtime.onInstalled.addListener(() => {
  initializeSidePanel();
});

chrome.runtime.onStartup.addListener(() => {
  initializeSidePanel();
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !isGradescopeUrl(tab.url)) {
    return;
  }

  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (error) {
    console.warn("Unable to open the side panel.", error);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  syncSidePanelForTab(tab).catch((error) => {
    console.warn("Unable to sync side panel state.", error);
  });

  if (changeInfo.status !== "complete") {
    return;
  }

  if (scrapeTabIds.has(tabId)) {
    return;
  }

  syncActiveSidePanelState(tab).catch((error) => {
    console.warn("Unable to update active side panel visibility.", error);
  });

  if (!isGradescopeUrl(tab.url)) {
    return;
  }

  maybeAutoRefresh("visit").catch((error) => {
    console.warn("Automatic Gradescope refresh failed.", error);
  });
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await syncSidePanelForTab(tab);
    await syncActiveSidePanelState(tab);

    if (!scrapeTabIds.has(tab.id) && isGradescopeUrl(tab.url)) {
      maybeAutoRefresh("tab_focus").catch((error) => {
        console.warn("Automatic Gradescope refresh on tab focus failed.", error);
      });
    }
  } catch (error) {
    console.warn("Unable to update active tab side panel state.", error);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    return;
  }

  if (message.type === "GET_CACHE") {
    handleGetCache(sendResponse);
    return true;
  }

  if (message.type === "START_REFRESH") {
    handleStartRefresh(message.reason || "manual", sendResponse);
    return true;
  }

  if (message.type === "PANEL_OPENED") {
    handlePanelOpened(sendResponse);
    return true;
  }

  if (message.type === "OPEN_ASSIGNMENT") {
    chrome.tabs.create({ url: message.url, active: true }).then(() => {
      sendResponse({ ok: true });
    }).catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }
});

async function initializeSidePanel() {
  if (!chrome.sidePanel || !chrome.sidePanel.setPanelBehavior) {
    return;
  }

  try {
    await chrome.sidePanel.setPanelBehavior({
      openPanelOnActionClick: true
    });
  } catch (error) {
    console.warn("Unable to configure side panel behavior.", error);
  }

  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map((tab) => syncSidePanelForTab(tab)));
  } catch (error) {
    console.warn("Unable to initialize Gradescope side panel tab state.", error);
  }
}

async function handleGetCache(sendResponse) {
  try {
    const cache = await getCache();
    sendResponse({
      ok: true,
      cache,
      refreshState
    });
  } catch (error) {
    sendResponse({
      ok: false,
      error: error.message
    });
  }
}

async function handleStartRefresh(reason, sendResponse) {
  try {
    const result = await refreshGradescopeData(reason);
    sendResponse({
      ok: true,
      result
    });
  } catch (error) {
    sendResponse({
      ok: false,
      error: error.message
    });
  }
}

async function handlePanelOpened(sendResponse) {
  try {
    const shouldRefresh = await shouldAutoRefresh();

    if (shouldRefresh && !refreshState.running) {
      maybeAutoRefresh("panel_open").catch((error) => {
        console.warn("Panel-open refresh failed.", error);
      });
    }

    sendResponse({
      ok: true,
      shouldRefresh,
      refreshState
    });
  } catch (error) {
    sendResponse({
      ok: false,
      error: error.message
    });
  }
}

async function maybeAutoRefresh(reason = "visit") {
  const now = Date.now();

  if (refreshState.running || now - lastVisitRefreshAt < AUTO_REFRESH_COOLDOWN_MS) {
    return;
  }

  if (!await shouldAutoRefresh(now)) {
    return;
  }

  lastVisitRefreshAt = now;
  await refreshGradescopeData(reason);
}

async function shouldAutoRefresh(now = Date.now()) {
  const cache = await getCache();
  return !cache || !cache.updatedAt || now - new Date(cache.updatedAt).getTime() > AUTO_REFRESH_MAX_AGE_MS;
}

async function refreshGradescopeData(reason) {
  if (refreshState.running) {
    return {
      alreadyRunning: true,
      refreshState
    };
  }

  const previousCache = await getCache();
  const scrapeTab = await createScrapeTab();
  const allAssignments = [];
  let courseResults = [];
  let dashboardCourses = [];

  refreshState = {
    running: true,
    startedAt: new Date().toISOString(),
    reason,
    progress: "Opening Gradescope dashboard...",
    currentCourse: null,
    completedCourses: 0,
    totalCourses: 0,
    lastError: null
  };

  await broadcastRefreshStatus();

  try {
    await navigateTab(scrapeTab.id, DASHBOARD_URL);
    refreshState.progress = "Scanning your Gradescope courses...";
    await broadcastRefreshStatus();

    const dashboardData = await sendTabMessageWithRetry(scrapeTab.id, {
      type: "GS_EXTRACT_DASHBOARD"
    });

    if (!dashboardData || dashboardData.requiresLogin) {
      throw new Error("Gradescope appears to require login. Open Gradescope in Chrome and confirm you are signed in.");
    }

    dashboardCourses = Array.isArray(dashboardData.courses) ? dashboardData.courses : [];
    refreshState.totalCourses = dashboardCourses.length;

    if (!dashboardCourses.length) {
      throw new Error("No Gradescope courses were found on the dashboard.");
    }

    await broadcastRefreshStatus();

    for (let index = 0; index < dashboardCourses.length; index += 1) {
      const course = dashboardCourses[index];
      refreshState.currentCourse = course.courseName || `Course ${index + 1}`;
      refreshState.progress = `Scanning course ${index + 1} of ${dashboardCourses.length}`;
      await broadcastRefreshStatus();

      const courseResult = await scrapeSingleCourse(scrapeTab.id, course);
      courseResults.push(courseResult);

      if (courseResult.status === "success" && Array.isArray(courseResult.assignments)) {
        mergeAssignments(allAssignments, courseResult.assignments);
      }

      refreshState.completedCourses = index + 1;
      await broadcastRefreshStatus();
    }

    const sortedAssignments = allAssignments.sort(compareAssignments);
    const failedCourses = courseResults.filter((course) => course.status !== "success");
    const cache = {
      source: "gradescope",
      assignments: sortedAssignments,
      updatedAt: new Date().toISOString(),
      partial: failedCourses.length > 0,
      errors: failedCourses.map((course) => ({
        courseName: course.courseName,
        courseUrl: course.courseUrl,
        error: course.error
      })),
      summary: {
        totalAssignments: sortedAssignments.length,
        courseCount: dashboardCourses.length,
        successfulCourses: courseResults.length - failedCourses.length,
        failedCourses: failedCourses.length
      },
      courseResults
    };

    await setCache(cache);

    refreshState = {
      running: false,
      startedAt: refreshState.startedAt,
      reason,
      progress: "Refresh complete.",
      currentCourse: null,
      completedCourses: dashboardCourses.length,
      totalCourses: dashboardCourses.length,
      lastError: null
    };

    await broadcastRefreshStatus();

    return {
      ok: true,
      cache
    };
  } catch (error) {
    const fallbackCache = previousCache || {
      source: "gradescope",
      assignments: [],
      updatedAt: null,
      partial: false,
      errors: [],
      summary: {
        totalAssignments: 0,
        courseCount: 0,
        successfulCourses: 0,
        failedCourses: 0
      },
      courseResults: []
    };

    fallbackCache.lastError = error.message;
    fallbackCache.lastAttemptAt = new Date().toISOString();
    await setCache(fallbackCache);

    refreshState = {
      running: false,
      startedAt: refreshState.startedAt,
      reason,
      progress: "Refresh failed.",
      currentCourse: null,
      completedCourses: refreshState.completedCourses,
      totalCourses: refreshState.totalCourses,
      lastError: error.message
    };

    await broadcastRefreshStatus();
    throw error;
  } finally {
    await closeScrapeTab(scrapeTab.id);
  }
}

async function scrapeSingleCourse(tabId, course) {
  try {
    const primaryAssignmentsUrl = buildAssignmentsPageUrl(course.courseUrl);
    await navigateTab(tabId, primaryAssignmentsUrl);

    let pageData = await sendTabMessageWithRetry(tabId, {
      type: "GS_EXTRACT_ASSIGNMENTS",
      courseHint: {
        ...course,
        courseUrl: primaryAssignmentsUrl
      }
    });

    const mergedAssignments = [];
    if (Array.isArray(pageData.assignments) && pageData.assignments.length) {
      mergeAssignments(mergedAssignments, pageData.assignments);
    }

    const candidateUrls = Array.isArray(pageData.assignmentListUrls) ? pageData.assignmentListUrls : [];
    const attemptedUrls = new Set([normalizeUrl(primaryAssignmentsUrl)]);

    if (!mergedAssignments.length && normalizeUrl(course.courseUrl) !== normalizeUrl(primaryAssignmentsUrl)) {
      attemptedUrls.add(normalizeUrl(course.courseUrl));
      await navigateTab(tabId, course.courseUrl);
      pageData = await sendTabMessageWithRetry(tabId, {
        type: "GS_EXTRACT_ASSIGNMENTS",
        courseHint: course
      });

      if (Array.isArray(pageData.assignments) && pageData.assignments.length) {
        mergeAssignments(mergedAssignments, pageData.assignments);
      }
    }

    for (const candidateUrl of candidateUrls) {
      const normalizedCandidate = normalizeUrl(candidateUrl);
      if (!normalizedCandidate || attemptedUrls.has(normalizedCandidate)) {
        continue;
      }

      attemptedUrls.add(normalizedCandidate);
      await navigateTab(tabId, candidateUrl);
      pageData = await sendTabMessageWithRetry(tabId, {
        type: "GS_EXTRACT_ASSIGNMENTS",
        courseHint: course
      });

      if (Array.isArray(pageData.assignments) && pageData.assignments.length) {
        mergeAssignments(mergedAssignments, pageData.assignments);
      }
    }

    const assignments = mergedAssignments.sort(compareAssignments);

    return {
      status: "success",
      courseName: pageData.courseName || course.courseName,
      courseUrl: course.courseUrl,
      assignmentCount: assignments.length,
      assignments
    };
  } catch (error) {
    return {
      status: "error",
      courseName: course.courseName,
      courseUrl: course.courseUrl,
      assignmentCount: 0,
      assignments: [],
      error: error.message
    };
  }
}

async function createScrapeTab() {
  const tab = await chrome.tabs.create({
    url: DASHBOARD_URL,
    active: false
  });

  scrapeTabIds.add(tab.id);
  await waitForTabComplete(tab.id);
  await delay(SCRAPE_WAIT_MS);
  return tab;
}

async function closeScrapeTab(tabId) {
  if (!tabId) {
    return;
  }

  scrapeTabIds.delete(tabId);

  try {
    await chrome.tabs.remove(tabId);
  } catch (error) {
    console.warn("Unable to close scrape tab.", error);
  }
}

async function navigateTab(tabId, url) {
  await chrome.tabs.update(tabId, {
    url,
    active: false
  });
  await waitForTabComplete(tabId);
  await delay(SCRAPE_WAIT_MS);
}

function waitForTabComplete(tabId) {
  return new Promise(async (resolve, reject) => {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && tab.status === "complete") {
        resolve();
        return;
      }
    } catch (error) {
      reject(error);
      return;
    }

    const timeoutId = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(handleUpdate);
      reject(new Error("Timed out while waiting for Gradescope to load."));
    }, TAB_TIMEOUT_MS);

    function handleUpdate(updatedTabId, changeInfo) {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") {
        return;
      }

      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(handleUpdate);
      resolve();
    }

    chrome.tabs.onUpdated.addListener(handleUpdate);
  });
}

async function sendTabMessageWithRetry(tabId, message, maxAttempts = 8) {
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }

  throw new Error(lastError ? lastError.message : "Unable to contact the Gradescope content script.");
}

function mergeAssignments(targetAssignments, nextAssignments) {
  const assignmentsByKey = new Map(
    targetAssignments.map((assignment) => [assignment.id || assignment.url, assignment])
  );

  for (const assignment of nextAssignments) {
    const key = assignment.id || assignment.url;
    const existing = assignmentsByKey.get(key);

    if (!existing) {
      assignmentsByKey.set(key, assignment);
      continue;
    }

    assignmentsByKey.set(key, {
      ...existing,
      ...assignment,
      dueAt: assignment.dueAt || existing.dueAt || null,
      dueLabel: assignment.dueLabel || existing.dueLabel || null,
      status: assignment.status || existing.status || null,
      points: assignment.points || existing.points || null,
      timestampText: assignment.timestampText || existing.timestampText || null
    });
  }

  targetAssignments.length = 0;
  targetAssignments.push(...assignmentsByKey.values());
}

function compareAssignments(left, right) {
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

function isGradescopeUrl(url) {
  return typeof url === "string" && url.startsWith(GRADESCOPE_ORIGIN);
}

async function syncSidePanelForTab(tab) {
  if (!tab || typeof tab.id !== "number" || !chrome.sidePanel || !chrome.sidePanel.setOptions) {
    return;
  }

  const enabled = isGradescopeUrl(tab.url);

  await chrome.sidePanel.setOptions({
    tabId: tab.id,
    path: "sidepanel.html",
    enabled
  });

  if (enabled) {
    await chrome.action.enable(tab.id);
    return;
  }

  await chrome.action.disable(tab.id);
}

async function syncActiveSidePanelState(tab) {
  if (!tab || !tab.active || typeof tab.windowId !== "number" || !chrome.sidePanel) {
    return;
  }

  if (scrapeTabIds.has(tab.id)) {
    return;
  }

  if (isGradescopeUrl(tab.url)) {
    try {
      await chrome.sidePanel.open({ tabId: tab.id });
    } catch (error) {
      console.warn("Unable to auto-open side panel on Gradescope tab.", error);
    }
    return;
  }

  if (!chrome.sidePanel.close) {
    return;
  }

  try {
    await chrome.sidePanel.close({ windowId: tab.windowId });
  } catch (error) {
    console.warn("Unable to close side panel after leaving Gradescope.", error);
  }
}

function normalizeUrl(url) {
  if (!url) {
    return null;
  }

  try {
    const normalized = new URL(url);
    normalized.hash = "";
    return normalized.toString();
  } catch (error) {
    return null;
  }
}

function buildAssignmentsPageUrl(courseUrl) {
  const courseId = extractCourseId(courseUrl);
  if (!courseId) {
    return courseUrl;
  }

  return `${GRADESCOPE_ORIGIN}/courses/${courseId}/assignments`;
}

function extractCourseId(url) {
  const match = String(url || "").match(/\/courses\/(\d+)/);
  return match ? match[1] : null;
}

async function getCache() {
  const stored = await chrome.storage.local.get(CACHE_KEY);
  return stored[CACHE_KEY] || null;
}

async function setCache(cache) {
  await chrome.storage.local.set({
    [CACHE_KEY]: cache
  });

  await safeSendMessage({
    type: "CACHE_UPDATED",
    cache
  });
}

async function broadcastRefreshStatus() {
  await safeSendMessage({
    type: "REFRESH_STATUS",
    refreshState
  });
}

async function safeSendMessage(message) {
  try {
    await chrome.runtime.sendMessage(message);
  } catch (error) {
    // No side panel may be listening, which is okay.
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
