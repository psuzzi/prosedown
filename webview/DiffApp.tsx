import React, { useEffect, useState } from "react";
import { DiffView } from "./components/DiffView";
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  type ProsedownSettings,
} from "./settings";
import { vscodeApi } from "./vscode-api";

interface DiffInit {
  oldContent: string;
  newContent: string;
  fileName: string;
  title?: string;
  baseUri?: string;
  settings?: Partial<ProsedownSettings>;
}

/**
 * Stripped-down App for the standalone diff webview. No Tiptap, no TOC,
 * no editor chrome — just DiffView driven by content the host posts in.
 */
export function DiffApp() {
  const [data, setData] = useState<DiffInit | null>(null);
  const [settings, setSettings] = useState<ProsedownSettings>(
    DEFAULT_SETTINGS,
  );

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === "diffInit") {
        if (msg.settings) {
          setSettings(mergeSettings(msg.settings));
        }
        setData({
          oldContent: msg.oldContent || "",
          newContent: msg.newContent || "",
          fileName: msg.fileName || "file.md",
          title: msg.title,
          baseUri: msg.baseUri,
        });
      } else if (msg.type === "diffUpdate") {
        // Host can push refreshed content (e.g. underlying file changed)
        setData((prev) =>
          prev
            ? {
                ...prev,
                oldContent: msg.oldContent ?? prev.oldContent,
                newContent: msg.newContent ?? prev.newContent,
              }
            : prev,
        );
      } else if (msg.type === "settingsUpdated") {
        setSettings(mergeSettings(msg.settings));
      }
    };
    window.addEventListener("message", handler);
    vscodeApi.postMessage({ type: "diffReady" });
    return () => window.removeEventListener("message", handler);
  }, []);

  const updateSetting = <K extends keyof ProsedownSettings>(
    key: K,
    value: ProsedownSettings[K],
  ) => {
    const next = { ...settings, [key]: value };
    setSettings(next);
    vscodeApi.postMessage({ type: "saveSettings", settings: next });
  };

  if (!data) {
    return <div className="diff-empty">Loading diff…</div>;
  }

  return (
    <DiffView
      oldContent={data.oldContent}
      newContent={data.newContent}
      fileName={data.fileName}
      title={data.title}
      baseUri={data.baseUri}
      layout={settings.diffLayout}
      mode={settings.diffMode}
      onEdit={() => vscodeApi.postMessage({ type: "editFile" })}
      onClose={() => vscodeApi.postMessage({ type: "closeDiff" })}
      onLayoutChange={(v) => updateSetting("diffLayout", v)}
      onModeChange={(v) => updateSetting("diffMode", v)}
    />
  );
}

