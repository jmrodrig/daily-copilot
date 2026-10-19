import { useEffect } from "react";

const APP_NAME = "Daily Co-Pilot";

// The page's title, and what's shown before it while something's going on (a recording: "⚪").
let pageTitle = "";
let titleStatus = "";

function applyTitle() {
  const title = pageTitle ? `${pageTitle} - ${APP_NAME}` : APP_NAME;
  document.title = titleStatus ? `${titleStatus} · ${title}` : title;
}

/** Show `title` in the window/tab title, followed by the app name. */
export function useTitle(title: string) {
  useEffect(() => {
    pageTitle = title;
    applyTitle();
  }, [title]);
}

/** Show `status` before the page's title in the window/tab title, till it's set back to "". */
export function setTitleStatus(status: string) {
  if (status === titleStatus) return;
  titleStatus = status;
  applyTitle();
}
