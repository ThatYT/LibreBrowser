import { tr } from "../librebrowser-i18n";
/** Compact presence and driver controls outside the replay iframe. */
import type { PresenceEntry, Up } from "@mirror/protocol";

export interface PresenceProps {
  viewers: readonly PresenceEntry[];
  viewerId: string | null;
  driverId: string | null;
  send: (message: Up) => void;
}

export function Presence({ viewers, viewerId, driverId, send }: PresenceProps) {
  const isDriver = viewerId !== null && viewerId === driverId;
  return (
    <section
      id="presence-chrome"
      aria-label={tr("Connected viewers", "已连接的设备")}
      data-viewer-role={viewerId === null ? "pending" : isDriver ? "driver" : "follower"}
    >
      <ul>
        {viewers.map((viewer) => (
          <li
            key={viewer.id}
            data-viewer-id={viewer.id}
            data-driver={viewer.id === driverId ? "true" : "false"}
            title={viewer.id}
          >
            <span class="presence-name">
              {viewer.name}
              {viewer.id === viewerId ? tr(" (you)", "（你）") : ""}
            </span>
            {viewer.id === driverId && <span class="presence-driver">{tr("Driver", "控制者")}</span>}
          </li>
        ))}
      </ul>
      {viewerId !== null && !isDriver && (
        <button
          type="button"
          class="request-driver"
          onClick={() => send({ t: "driver-transfer", to: viewerId })}
        >
          {tr("Take control", "接管控制")}
        </button>
      )}
    </section>
  );
}
