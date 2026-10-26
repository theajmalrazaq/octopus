// Shared types for the agent.

export interface ScheduleBlock {
  start: string; // "HH:MM" 24h, agent timezone
  end: string; // "HH:MM" 24h
  name: string;
}

export type PersonaGender = 'feminine' | 'masculine' | 'neutral';

export interface AgentConfig {
  botName: string;
  /** Spare WhatsApp number that IS the agent (digits only, with country code). */
  botNumber: string;
  /** The owner's number (digits only). Only this person may DM the agent. */
  ownerNumber: string;
  /** IANA timezone the agent lives in, e.g. "Asia/Karachi". */
  timezone: string;
  llm: {
    enabled: boolean;
    model: string;
    apiBase: string;
  };
  persona: {
    gender: PersonaGender;
    /** Free-text voice/style instructions from the owner, injected into the prompt. */
    voiceNotes: string;
    /** "Memories": facts the owner wants the agent to always know. */
    ownerNotes: string;
  };
  /** Weekly recurring busy blocks: keys "0" (Sunday) … "6" (Saturday). Empty = no schedule features. */
  timetable: Record<string, ScheduleBlock[]>;
  meetup: {
    enabled: boolean;
    groupJid: string;
    askTime: string; // "HH:MM"
    cutoffTime: string; // "HH:MM"
  };
  access: {
    /** Groups the agent will respond in (the meetup group is always allowed). DMs are owner-only. */
    groupJids: string[];
  };
}

export interface Reminder {
  rowid: number;
  /** Per-chat reminder number (each chat counts from 1). */
  seq: number;
  jid: string;
  text: string;
  /** Epoch ms. */
  dueAt: number;
  repeat: 'daily' | 'weekly' | null;
  createdBy: string;
}

export interface HistoryEntry {
  role: 'user' | 'assistant';
  content: string;
}

export interface GroupMember {
  pn: string;
  lid: string;
  name: string;
  admin: boolean;
}

export interface GroupInfo {
  name: string;
  desc: string;
  members: GroupMember[];
  updatedAt: number;
}

export interface MeetupState {
  date: string; // YYYY-MM-DD the state belongs to
  asked: boolean;
  status: 'idle' | 'pending' | 'confirmed' | 'missed';
  missedPosted: boolean;
}

/** Everything the brain needs to know about one incoming message. */
export interface MsgContext {
  jid: string;
  isGroup: boolean;
  senderNumber: string;
  senderName: string;
  isOwner: boolean;
  groupContext: GroupInfo | null;
}
