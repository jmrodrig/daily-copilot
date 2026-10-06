import { useEffect } from "react";

const APP_NAME = "Daily Co-Pilot";

/** Show `title` in the window/tab title, followed by the app name. */
export function useTitle(title: string) {
  useEffect(() => {
    document.title = title ? `${title} - ${APP_NAME}` : APP_NAME;
  }, [title]);
}
