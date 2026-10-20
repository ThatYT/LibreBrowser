import { tr } from "../librebrowser-i18n";
/** A user-gesture clipboard bridge outside the replay iframe. */

export interface ClipboardPromptProps {
  text: string | null;
  error?: string | null;
  writeText?: (text: string) => Promise<void>;
  onCopied: () => void;
  onCopyError?: (error: unknown) => void;
}

function writeLocalClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText === undefined) {
    return Promise.reject(new Error("Clipboard access is unavailable"));
  }
  return navigator.clipboard.writeText(text);
}

export function ClipboardPrompt({
  text,
  error = null,
  writeText = writeLocalClipboard,
  onCopied,
  onCopyError,
}: ClipboardPromptProps) {
  return (
    <aside
      id="clipboard-prompt-layer"
      aria-label={tr("Remote clipboard", "远程剪贴板")}
      aria-hidden={text === null ? "true" : undefined}
    >
      {text !== null && (
        <section class="clipboard-prompt">
          <span>{tr("The remote page copied text.", "远程网页已复制文本。")}</span>
          <button
            type="button"
            onClick={async () => {
              try {
                await writeText(text);
                onCopied();
              } catch (copyError) {
                onCopyError?.(copyError);
              }
            }}
          >
            {tr("Copy to my clipboard", "复制到本机剪贴板")}
          </button>
          {error !== null && (
            <span class="clipboard-error" role="alert">
              {error}
            </span>
          )}
        </section>
      )}
    </aside>
  );
}
