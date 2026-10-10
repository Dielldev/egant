import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { create } from "zustand";
import { log } from "./logger";
import { useEgant } from "../store";

/** Where an update is. `available` is the state the sidebar's Update button
 * lives in; everything before it is invisible and everything after is that
 * button saying what it is doing. */
export type UpdateStatus = "idle" | "checking" | "available" | "downloading" | "installed";

interface UpdaterState {
  status: UpdateStatus;
  /** The version on offer, once `check` has found one. */
  version: string | null;
  /** The release notes GitHub carries for it. */
  notes: string | null;
  /** 0–1 while downloading; `null` until the server says how big it is. */
  progress: number | null;
}

export const useUpdater = create<UpdaterState>(() => ({
  status: "idle",
  version: null,
  notes: null,
  progress: null,
}));

/** The handle `check` returned, which is what knows how to install itself.
 * Not state: nothing renders from it, and it is not serializable. */
let pending: Update | null = null;

/** Asks GitHub whether a newer release exists.
 *
 * `manual` is a person asking (the app menu): they get an answer either way.
 * An automatic check stays silent unless there is something to install, since
 * "you're up to date" every few hours is noise and a failed check with no
 * network is not the user's problem. */
export async function checkForUpdates(manual = false): Promise<void> {
  const { status } = useUpdater.getState();
  // One thing at a time, and never re-check out from under an install.
  if (status === "checking" || status === "downloading" || status === "installed") return;
  // Already found one: a manual ask just points at the button.
  if (status === "available" && manual) {
    useEgant.getState().showNotice(`egant ${useUpdater.getState().version} is ready — use Update in the sidebar.`);
    return;
  }
  useUpdater.setState({ status: "checking" });
  try {
    const update = await check();
    if (update) {
      pending = update;
      useUpdater.setState({
        status: "available",
        version: update.version,
        notes: update.body ?? null,
        progress: null,
      });
      log.info("updater", `egant ${update.version} is available`);
      if (manual) useEgant.getState().showNotice(`egant ${update.version} is available — use Update in the sidebar.`);
    } else {
      useUpdater.setState({ status: "idle" });
      if (manual) useEgant.getState().showNotice("egant is up to date.");
    }
  } catch (error) {
    useUpdater.setState({ status: "idle" });
    log.warn("updater", `update check failed: ${String(error)}`);
    if (manual) useEgant.getState().showNotice(`Couldn't check for updates: ${String(error)}`);
  }
}

/** Downloads the update found by `checkForUpdates`, installs it over this app,
 * and restarts into it. The bundle is verified against the public key in
 * tauri.conf.json before anything is replaced. */
export async function installUpdate(): Promise<void> {
  const update = pending;
  if (!update || useUpdater.getState().status !== "available") return;
  useUpdater.setState({ status: "downloading", progress: null });
  try {
    let total = 0;
    let received = 0;
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength ?? 0;
      } else if (event.event === "Progress") {
        received += event.data.chunkLength;
        if (total > 0) useUpdater.setState({ progress: Math.min(1, received / total) });
      }
    });
    useUpdater.setState({ status: "installed", progress: 1 });
    await relaunch();
  } catch (error) {
    // Back to a button that can be pressed again.
    useUpdater.setState({ status: "available", progress: null });
    log.error("updater", `update failed: ${String(error)}`, error);
    useEgant.getState().showNotice(`The update didn't install: ${String(error)}`);
  }
}
