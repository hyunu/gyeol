import type {
  ActionItem,
  Conversation,
  ConversationDetail,
  Device,
  Person,
  Recording,
  UploadSession,
} from "../domain/types.ts";
import { isDeletable } from "../domain/recording.ts";
import { isDeviceOnline } from "../domain/device.ts";
import type { ConversationListItem } from "../ports/store.ts";

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function deviceDto(device: Device, now: Date) {
  return {
    id: device.id,
    userId: device.userId,
    serialNo: device.serialNo,
    model: device.model,
    hardwareRevision: device.hardwareRevision,
    firmwareVersion: device.firmwareVersion,
    lifecycleStatus: device.lifecycleStatus,
    online: isDeviceOnline(device.lastSeenAt, now),
    lastSeenAt: iso(device.lastSeenAt),
    batteryPct: device.batteryPct,
    storageFreeBytes: device.storageFreeBytes,
    createdAt: device.createdAt.toISOString(),
    updatedAt: device.updatedAt.toISOString(),
  };
}

export function recordingDto(recording: Recording) {
  const audioAvailable =
    Boolean(recording.storageKey) &&
    (recording.status === "stored" || recording.status === "analyzed" || recording.status === "analysis_failed");
  return {
    id: recording.id,
    deviceId: recording.deviceId,
    clientRecordingId: recording.clientRecordingId,
    status: recording.status,
    startedAt: recording.startedAt.toISOString(),
    endedAt: recording.endedAt.toISOString(),
    durationMs: recording.durationMs,
    codec: recording.codec,
    codecParams: recording.codecParams,
    sampleRateHz: recording.sampleRateHz,
    channels: recording.channels,
    byteSize: recording.byteSize,
    sha256: recording.sha256,
    audioAvailable,
    deletable: isDeletable(recording),
    integrityVerifiedAt: iso(recording.integrityVerifiedAt),
    storageVerifiedAt: iso(recording.storageVerifiedAt),
    clientAckAt: iso(recording.clientAckAt),
    analyzedAt: iso(recording.analyzedAt),
    purgedAt: iso(recording.purgedAt),
    createdAt: recording.createdAt.toISOString(),
    updatedAt: recording.updatedAt.toISOString(),
  };
}

export function uploadSessionDto(session: UploadSession) {
  return {
    id: session.id,
    recordingId: session.recordingId,
    status: session.status,
    expectedBytes: session.expectedBytes,
    receivedBytes: session.receivedBytes,
    chunkSizeBytes: session.chunkSizeBytes,
    nextOffset: session.receivedBytes,
    expiresAt: session.expiresAt.toISOString(),
    completedAt: iso(session.completedAt),
    createdAt: session.createdAt.toISOString(),
  };
}

export function personDto(person: Person) {
  return {
    id: person.id,
    displayName: person.displayName,
    notes: person.notes,
    createdAt: person.createdAt.toISOString(),
  };
}

export function actionItemDto(item: ActionItem) {
  return {
    id: item.id,
    conversationId: item.conversationId,
    title: item.title,
    dueAt: iso(item.dueAt),
    status: item.status,
    confidence: item.confidence,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
    completedAt: iso(item.completedAt),
  };
}

function conversationSummary(conversation: Conversation, people: Person[], recordingIds: string[]) {
  return {
    id: conversation.id,
    title: conversation.title,
    summary: conversation.summary,
    language: conversation.language,
    startedAt: conversation.startedAt.toISOString(),
    endedAt: conversation.endedAt.toISOString(),
    status: conversation.status,
    analysisVersion: conversation.analysisVersion,
    people: people.map((p) => ({ id: p.id, displayName: p.displayName })),
    recordingIds,
    createdAt: conversation.createdAt.toISOString(),
  };
}

export function conversationListDto(item: ConversationListItem) {
  return conversationSummary(item.conversation, item.people, item.recordingIds);
}

export function conversationDetailDto(detail: ConversationDetail) {
  return {
    ...conversationSummary(detail.conversation, detail.people, detail.recordingIds),
    speakers: detail.speakers.map((s) => ({
      id: s.id,
      label: s.label,
      personId: s.personId,
      displayName: detail.people.find((p) => p.id === s.personId)?.displayName ?? null,
      identificationStatus: s.identificationStatus,
      confidence: s.confidence,
    })),
    segments: detail.segments.map((s) => ({
      id: s.id,
      seq: s.seq,
      startMs: s.startMs,
      endMs: s.endMs,
      text: s.text,
      speakerClusterId: s.speakerClusterId,
      confidence: s.confidence,
    })),
    entities: detail.entities.map((e) => ({
      id: e.id,
      kind: e.kind,
      value: e.value,
      normalizedValue: e.normalizedValue,
      confidence: e.confidence,
    })),
    actionItems: detail.actionItems.map((a) => ({
      id: a.id,
      title: a.title,
      dueAt: iso(a.dueAt),
      status: a.status,
      confidence: a.confidence,
    })),
  };
}
