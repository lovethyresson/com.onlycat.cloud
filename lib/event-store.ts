/**
 * The event pipeline.
 *
 * The part of this API that is easiest to get wrong, because a `DeviceEvent` on its own cannot
 * tell you whether the cat got in. Allow-versus-deny lives only in the SUMMARY. OnlyCat's own
 * developer discussion is the record of this being the API's headline gap.
 *
 *   deviceEventUpdate {deviceId, eventId, body:{accessToken}}   <- a flap event started
 *     |- getEvent        -> classification, frameCount, poster frame
 *     '- getEventSummary -> subevents: action x direction x rfidCode
 *   eventUpdate         -> progressed;  frameCount set          => event concluded
 *   eventSummaryUpdate  -> progressed;  processed === frameCount => summary FINAL
 *
 * Three traps, all handled here:
 *
 *  1. `frameCount === null` means still in progress, and `rfidCodes` is usually empty at that
 *     point — chip reads arrive late. The first push is never the whole story.
 *  2. A summary is PROVISIONAL until `processedFrameCount === frameCount`, and it changes: a
 *     TRANSIT gets demoted to a PEEK when the cat thinks better of it. Homey Flow cannot un-fire
 *     a trigger, so we fire on final only.
 *  3. Events can arrive out of order. Guard on `eventId` before overwriting anything.
 */

import { OnlyCatEvent, OnlyCatEventSummary, OnlyCatSubEvent } from './onlycat/models';

export interface TrackedEvent {
    deviceId: string;
    eventId: number;
    event: OnlyCatEvent;
    summary: OnlyCatEventSummary | null;
    /** True once the subevents have been handed to the app; prevents double-firing. */
    settled: boolean;
}

export function isEventConcluded(event: OnlyCatEvent | null | undefined): boolean {
  return event?.frameCount != null;
}

/**
 * A summary is final when it has processed every frame the event turned out to have. Both halves
 * are required: a summary that has processed 200 frames tells you nothing until you know whether
 * the event was 200 frames or 450.
 */
export function isSummaryFinal(
  event: OnlyCatEvent | null | undefined,
  summary: OnlyCatEventSummary | null | undefined,
): boolean {
  if (!event || !summary) return false;
  if (event.frameCount == null) return false;
  if (summary.processedFrameCount == null) return false;
  return summary.processedFrameCount >= event.frameCount;
}

/** Frame to show for an event: the poster frame, else the midpoint, else the first. */
export function posterFrame(event: OnlyCatEvent): number {
  if (event.posterFrameIndex != null) return event.posterFrameIndex;
  if (event.frameCount != null) return Math.floor(event.frameCount / 2);
  return 1;
}

export function imageUrl(gatewayUrl: string, event: OnlyCatEvent): string {
  return `${gatewayUrl}/events/${event.deviceId}/${event.eventId}/${posterFrame(event)}`;
}

/** Drops subevents missing any of the fields we act on rather than half-reading them. */
export function usableSubevents(summary: OnlyCatEventSummary | null | undefined): OnlyCatSubEvent[] {
  if (!summary?.subevents) return [];
  return summary.subevents.filter((s) => s && s.action != null && s.direction != null);
}

/**
 * Per-device event state. One instance per Homey device; not shared, because two flaps number
 * their events independently and `eventId` is per-device.
 */
export class EventStore {
    private current: TrackedEvent | null = null;

    get tracked(): TrackedEvent | null {
      return this.current;
    }

    /** True when this id is not older than what we already hold. */
    private accepts(eventId: number): boolean {
      return this.current == null || eventId >= this.current.eventId;
    }

    /** A new event started. Returns false when the push was stale and should be ignored. */
    begin(deviceId: string, eventId: number, accessToken: string | null): boolean {
      if (!this.accepts(eventId)) return false;

      if (this.current?.eventId === eventId) {
        if (accessToken && !this.current.event.accessToken) {
          this.current.event.accessToken = accessToken;
        }
        return true;
      }

      this.current = {
        deviceId,
        eventId,
        event: { deviceId, eventId, accessToken },
        summary: null,
        settled: false,
      };
      return true;
    }

    /** Merge an event payload. Returns false when stale. */
    applyEvent(event: OnlyCatEvent): boolean {
      if (event.eventId == null || !this.accepts(event.eventId)) return false;

      if (this.current?.eventId !== event.eventId) {
        this.current = {
          deviceId: event.deviceId,
          eventId: event.eventId,
          event: { ...event },
          summary: null,
          settled: false,
        };
        return true;
      }

      // Merge rather than replace: a later push can omit fields an earlier one carried, and
      // `accessToken` in particular arrives on deviceEventUpdate and not always again.
      this.current.event = { ...this.current.event, ...event };
      return true;
    }

    /** Merge a summary payload. Returns false when stale. */
    applySummary(summary: OnlyCatEventSummary): boolean {
      if (summary.eventId == null || !this.accepts(summary.eventId)) return false;
      if (!this.current || this.current.eventId !== summary.eventId) {
        this.current = {
          deviceId: summary.deviceId,
          eventId: summary.eventId,
          event: { deviceId: summary.deviceId, eventId: summary.eventId },
          summary,
          settled: false,
        };
        return true;
      }
      this.current.summary = summary;
      return true;
    }

    /**
     * The subevents to act on, or null if we are not ready to commit to them yet.
     *
     * Returns non-null exactly once per event — `settled` makes this idempotent, so the several
     * `eventSummaryUpdate` pushes that arrive after the final one do not re-fire every Flow.
     */
    settle(): OnlyCatSubEvent[] | null {
      const tracked = this.current;
      if (!tracked || tracked.settled) return null;
      if (!isSummaryFinal(tracked.event, tracked.summary)) return null;

      tracked.settled = true;
      return usableSubevents(tracked.summary);
    }

    /**
     * Give up waiting for a final summary and settle on what we have.
     *
     * Needed because an event with no cat in it — a human walking past, a leaf — concludes with
     * `frameCount` set but may never produce a summary worth the name. Without this the store
     * would hold a never-settled event forever and the next one would look stale.
     */
    settleStale(): OnlyCatSubEvent[] | null {
      const tracked = this.current;
      if (!tracked || tracked.settled) return null;
      if (!isEventConcluded(tracked.event)) return null;

      tracked.settled = true;
      return usableSubevents(tracked.summary);
    }
}
