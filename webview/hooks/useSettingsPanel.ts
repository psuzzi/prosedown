import { useRef, useState, useCallback } from "react";
import type { MutableRefObject } from "react";
import { DEFAULT_SETTINGS, type ProsedownSettings } from "../settings";
import { vscodeApi } from "../vscode-api";

export function useSettingsPanel(
  handleUpdateRef: MutableRefObject<() => void>,
) {
  const settingsRef = useRef<ProsedownSettings>(DEFAULT_SETTINGS);
  const [settings, setSettings] =
    useState<ProsedownSettings>(DEFAULT_SETTINGS);
  const [settingsVisible, setSettingsVisible] = useState(false);

  const updateSettings = useCallback(
    (next: ProsedownSettings) => {
      settingsRef.current = next;
      setSettings(next);
      vscodeApi.postMessage({ type: "saveSettings", settings: next });
      handleUpdateRef.current();
    },
    [handleUpdateRef],
  );

  /** Apply settings from an external source (e.g. init message) without
   *  triggering a re-serialization of the document. */
  const applySettings = useCallback((s: ProsedownSettings) => {
    settingsRef.current = s;
    setSettings(s);
  }, []);

  return {
    settings,
    settingsRef,
    settingsVisible,
    setSettingsVisible,
    updateSettings,
    applySettings,
  };
}
