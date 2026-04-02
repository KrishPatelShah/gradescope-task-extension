(() => {
  const KNOWN_STATUS_LABELS = [
    "Submitted",
    "No Submission",
    "Missing",
    "Late",
    "Graded",
    "Released",
    "Open",
    "Closed",
    "In Progress",
    "Not Submitted"
  ];

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) {
      return;
    }

    if (message.type === "GS_EXTRACT_DASHBOARD") {
      sendResponse(extractDashboardData());
      return true;
    }

    if (message.type === "GS_EXTRACT_ASSIGNMENTS") {
      sendResponse(extractAssignmentsFromPage(message.courseHint || null));
      return true;
    }
  });

  function extractDashboardData() {
    if (isLoginPage()) {
      return {
        ok: false,
        requiresLogin: true,
        courses: []
      };
    }

    const courses = collectCourseLinks();
    return {
      ok: true,
      requiresLogin: false,
      courses,
      url: window.location.href,
      title: document.title
    };
  }

  function extractAssignmentsFromPage(courseHint) {
    if (isLoginPage()) {
      return {
        ok: false,
        requiresLogin: true,
        courseName: courseHint && courseHint.courseName ? courseHint.courseName : "Unknown Course",
        courseUrl: courseHint && courseHint.courseUrl ? courseHint.courseUrl : window.location.href,
        assignments: [],
        assignmentListUrls: []
      };
    }

    const courseUrl = findCanonicalCourseUrl(courseHint);
    const courseName = findCourseName(courseHint);
    const assignmentListUrls = collectAssignmentListUrls(courseUrl);
    const assignments = collectAssignments(courseName, courseUrl);

    return {
      ok: true,
      requiresLogin: false,
      courseName,
      courseUrl,
      assignments,
      assignmentListUrls,
      url: window.location.href,
      title: document.title
    };
  }

  function isLoginPage() {
    const path = window.location.pathname;
    if (path.includes("/login") || path.includes("/logout")) {
      return true;
    }

    return Boolean(document.querySelector("form[action*='login'], input[name='session[email]']"));
  }

  function collectCourseLinks() {
    const courseMap = new Map();
    const anchors = Array.from(document.querySelectorAll("a[href*='/courses/']"));

    for (const anchor of anchors) {
      const url = normalizeAbsoluteUrl(anchor.getAttribute("href"));
      const courseId = extractCourseId(url);

      if (!courseId || courseMap.has(courseId)) {
        continue;
      }

      const courseUrl = `${window.location.origin}/courses/${courseId}`;
      const card = anchor.closest(".courseBox, .courseListItem, article, li, section, div");
      const courseName = cleanText(
        findFirstText(card, [
          ".courseBox--shortname",
          ".courseBox--name",
          "h1",
          "h2",
          "h3",
          "h4",
          "strong",
          "b"
        ]) || anchor.textContent
      );

      if (!courseName) {
        continue;
      }

      courseMap.set(courseId, {
        courseName,
        courseUrl
      });
    }

    return Array.from(courseMap.values()).sort((left, right) => left.courseName.localeCompare(right.courseName));
  }

  function findCanonicalCourseUrl(courseHint) {
    const hintedId = extractCourseId(courseHint && courseHint.courseUrl ? courseHint.courseUrl : "");
    const currentId = extractCourseId(window.location.href);
    const courseId = currentId || hintedId;

    if (courseId) {
      return `${window.location.origin}/courses/${courseId}`;
    }

    return courseHint && courseHint.courseUrl ? courseHint.courseUrl : window.location.href;
  }

  function findCourseName(courseHint) {
    const hintedName = courseHint && courseHint.courseName ? courseHint.courseName : "";
    const headingText = cleanText(
      findFirstText(document, [
        "h1.courseHeader--title",
        ".courseHeader h1",
        "main h1",
        "h1"
      ])
    );

    if (headingText) {
      return headingText;
    }

    const breadcrumbText = cleanText(findFirstText(document, [".breadcrumb", ".breadcrumbs", "nav[aria-label='Breadcrumb']"]));
    if (breadcrumbText) {
      return breadcrumbText.split("/").map((part) => cleanText(part)).filter(Boolean).pop() || hintedName || "Unknown Course";
    }

    return hintedName || "Unknown Course";
  }

  function collectAssignmentListUrls(courseUrl) {
    const courseId = extractCourseId(courseUrl);
    const results = new Set();

    if (!courseId) {
      return [];
    }

    const anchors = Array.from(document.querySelectorAll("a[href*='/courses/']"));

    for (const anchor of anchors) {
      const url = normalizeAbsoluteUrl(anchor.getAttribute("href"));
      if (!url || !url.includes(`/courses/${courseId}/`)) {
        continue;
      }

      const text = cleanText(anchor.textContent).toLowerCase();
      if (!url.includes("/assignments") && !text.includes("assignment")) {
        continue;
      }

      results.add(url);
    }

    return Array.from(results);
  }

  function collectAssignments(courseName, courseUrl) {
    const assignmentLinks = Array.from(document.querySelectorAll("a[href*='/assignments/']"));
    const seenUrls = new Set();
    const assignments = [];

    for (const link of assignmentLinks) {
      const url = normalizeAbsoluteUrl(link.getAttribute("href"));
      const assignmentId = extractAssignmentId(url);

      if (!assignmentId || !url || seenUrls.has(url)) {
        continue;
      }

      const container = findAssignmentContainer(link);
      const assignment = buildAssignment(link, container, courseName, courseUrl, url, assignmentId);

      if (!assignment || !assignment.title) {
        continue;
      }

      seenUrls.add(url);
      assignments.push(assignment);
    }

    return dedupeAssignments(assignments).sort(compareAssignments);
  }

  function findAssignmentContainer(link) {
    return link.closest("tr, li, article, section, [role='row'], .card, .assignment, .submission") || link.parentElement;
  }

  function buildAssignment(link, container, courseName, courseUrl, url, assignmentId) {
    const rawLines = extractTextLines(container);
    const title = cleanText(
      link.textContent ||
      findFirstText(container, ["h2", "h3", "h4", ".name", ".title", ".assignmentName", ".submissionTitle"])
    );

    if (!title) {
      return null;
    }

    const dueInfo = findDueInfo(container, rawLines);
    const points = findPoints(rawLines);
    const status = findStatus(container, rawLines);

    return {
      id: buildAssignmentId(courseUrl, assignmentId),
      title,
      courseName: cleanText(courseName) || "Unknown Course",
      dueAt: dueInfo.isoString,
      dueLabel: dueInfo.label,
      status,
      points,
      url,
      courseUrl,
      source: "gradescope",
      timestampText: dueInfo.timestampText
    };
  }

  function findDueInfo(container, rawLines) {
    const timestampCandidates = [];
    const timeElements = Array.from(container.querySelectorAll("time"));

    for (const timeElement of timeElements) {
      const datetime = timeElement.getAttribute("datetime");
      if (datetime) {
        const parsedDatetime = new Date(datetime);
        if (!Number.isNaN(parsedDatetime.getTime())) {
          const readableText = cleanText(timeElement.textContent) || formatDate(parsedDatetime);
          return {
            isoString: parsedDatetime.toISOString(),
            label: readableText.startsWith("Due") ? readableText : `Due ${readableText}`,
            timestampText: readableText
          };
        }
      }
    }

    const selectors = [
      "[class*='due']",
      "[class*='time']",
      "[class*='date']",
      "[class*='submission']",
      ".label",
      ".badge"
    ];

    for (const selector of selectors) {
      for (const element of Array.from(container.querySelectorAll(selector))) {
        const text = cleanText(element.textContent);
        if (looksLikeTimestamp(text)) {
          timestampCandidates.push(text);
        }
      }
    }

    for (const line of rawLines) {
      if (looksLikeTimestamp(line)) {
        timestampCandidates.push(line);
      }
    }

    const uniqueCandidates = Array.from(new Set(timestampCandidates));

    for (const candidate of uniqueCandidates) {
      const parsed = parseDateFromText(candidate);
      if (parsed) {
        return {
          isoString: parsed.toISOString(),
          label: buildDueLabel(candidate, parsed),
          timestampText: candidate
        };
      }
    }

    return {
      isoString: null,
      label: null,
      timestampText: uniqueCandidates[0] || null
    };
  }

  function findPoints(rawLines) {
    for (const line of rawLines) {
      const pointsMatch = line.match(/\b\d+(?:\.\d+)?\s*(?:pts?|points?)\b/i);
      if (pointsMatch) {
        return pointsMatch[0];
      }
    }

    return null;
  }

  function findStatus(container, rawLines) {
    const badgeSelectors = [
      "[class*='status']",
      "[class*='badge']",
      "[class*='pill']",
      "[class*='chip']",
      ".label"
    ];

    for (const selector of badgeSelectors) {
      for (const element of Array.from(container.querySelectorAll(selector))) {
        const text = cleanText(element.textContent);
        const normalized = matchKnownStatus(text);
        if (normalized) {
          return normalized;
        }
      }
    }

    for (const line of rawLines) {
      const normalized = matchKnownStatus(line);
      if (normalized) {
        return normalized;
      }
    }

    return null;
  }

  function buildAssignmentId(courseUrl, assignmentId) {
    const courseId = extractCourseId(courseUrl) || "course";
    return `${courseId}:${assignmentId}`;
  }

  function dedupeAssignments(assignments) {
    const seen = new Map();

    for (const assignment of assignments) {
      const existing = seen.get(assignment.id);
      if (!existing) {
        seen.set(assignment.id, assignment);
        continue;
      }

      seen.set(assignment.id, {
        ...existing,
        ...assignment,
        dueAt: assignment.dueAt || existing.dueAt || null,
        dueLabel: assignment.dueLabel || existing.dueLabel || null,
        status: assignment.status || existing.status || null,
        points: assignment.points || existing.points || null,
        timestampText: assignment.timestampText || existing.timestampText || null
      });
    }

    return Array.from(seen.values());
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

    return new Date(left.dueAt).getTime() - new Date(right.dueAt).getTime();
  }

  function extractTextLines(container) {
    const text = cleanText(container ? container.innerText : "");
    return text.split("\n").map((line) => cleanText(line)).filter(Boolean);
  }

  function normalizeAbsoluteUrl(href) {
    if (!href) {
      return null;
    }

    try {
      const url = new URL(href, window.location.origin);
      url.hash = "";
      return url.toString();
    } catch (error) {
      return null;
    }
  }

  function extractCourseId(url) {
    const match = String(url || "").match(/\/courses\/(\d+)/);
    return match ? match[1] : null;
  }

  function extractAssignmentId(url) {
    const match = String(url || "").match(/\/assignments\/(\d+)/);
    return match ? match[1] : null;
  }

  function looksLikeTimestamp(text) {
    if (!text) {
      return false;
    }

    return /due|deadline|available|today|tomorrow|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b|\d{1,2}\/\d{1,2}/i.test(text);
  }

  function parseDateFromText(text) {
    const cleaned = cleanText(text)
      .replace(/submission due/ig, "Due")
      .replace(/due date/ig, "Due")
      .replace(/deadline/ig, "Due")
      .replace(/[|•]/g, " ");

    const directCandidate = cleaned.replace(/^(due|available until|available|closes)\s*[:\-]?\s*/i, "");
    const relativeDate = parseRelativeDate(directCandidate);
    if (relativeDate) {
      return relativeDate;
    }

    const withYear = addCurrentYearIfMissing(directCandidate);
    const parsed = new Date(withYear);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }

    const fallbackMatch = cleaned.match(/((?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*[^,\n]*\d{1,2}(?:,\s*\d{4})?(?:[^0-9a-zA-Z]+\d{1,2}(?::\d{2})?\s*[ap]m)?)/i);
    if (fallbackMatch) {
      const fallback = addCurrentYearIfMissing(fallbackMatch[1]);
      const fallbackDate = new Date(fallback);
      if (!Number.isNaN(fallbackDate.getTime())) {
        return fallbackDate;
      }
    }

    const numericMatch = cleaned.match(/(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?(?:\s+at\s+\d{1,2}(?::\d{2})?\s*[ap]m)?)/i);
    if (numericMatch) {
      const numericDate = new Date(addCurrentYearIfMissing(numericMatch[1]));
      if (!Number.isNaN(numericDate.getTime())) {
        return numericDate;
      }
    }

    return null;
  }

  function parseRelativeDate(text) {
    const lowered = text.toLowerCase();
    const now = new Date();
    let targetDate = null;

    if (lowered.includes("today")) {
      targetDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    }

    if (lowered.includes("tomorrow")) {
      targetDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    }

    if (!targetDate) {
      return null;
    }

    const timeMatch = text.match(/(\d{1,2})(?::(\d{2}))?\s*([ap]m)/i);
    if (timeMatch) {
      let hour = Number(timeMatch[1]);
      const minute = Number(timeMatch[2] || "0");
      const meridiem = timeMatch[3].toLowerCase();

      if (meridiem === "pm" && hour !== 12) {
        hour += 12;
      }

      if (meridiem === "am" && hour === 12) {
        hour = 0;
      }

      targetDate.setHours(hour, minute, 0, 0);
    }

    return targetDate;
  }

  function addCurrentYearIfMissing(text) {
    if (/\b\d{4}\b/.test(text)) {
      return text;
    }

    const currentYear = String(new Date().getFullYear());

    if (/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/i.test(text)) {
      return text.replace(
        /((?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2})(.*)/i,
        `$1, ${currentYear}$2`
      );
    }

    if (/^\d{1,2}\/\d{1,2}\b/.test(text)) {
      return text.replace(/^(\d{1,2}\/\d{1,2})(.*)$/, `$1/${currentYear}$2`);
    }

    return text;
  }

  function buildDueLabel(sourceText, parsedDate) {
    const cleaned = cleanText(sourceText);
    if (/^due/i.test(cleaned)) {
      return cleaned;
    }

    return `Due ${formatDate(parsedDate)}`;
  }

  function formatDate(date) {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    }).format(date);
  }

  function matchKnownStatus(text) {
    const cleaned = cleanText(text);

    for (const label of KNOWN_STATUS_LABELS) {
      const pattern = new RegExp(`\\b${escapeForRegExp(label)}\\b`, "i");
      if (pattern.test(cleaned)) {
        return label;
      }
    }

    return null;
  }

  function findFirstText(root, selectors) {
    for (const selector of selectors) {
      const element = root.querySelector(selector);
      const text = cleanText(element ? element.textContent : "");
      if (text) {
        return text;
      }
    }

    return "";
  }

  function cleanText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function escapeForRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
})();
