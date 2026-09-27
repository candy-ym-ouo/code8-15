export type BookStatus = 'TO_READ' | 'READING' | 'READ' | 'PAUSED' | 'ABANDONED';
export type MoodTag = 'MOVED' | 'CALM' | 'JOYFUL' | 'SAD' | 'ANGRY' | 'CONFUSED' | 'RELIEVED' | 'EMPTY' | 'CHANGED';
export type TraceType = 'DOG_EAR' | 'ANNOTATION' | 'REREAD_MARK';
export type ExcerptCardStatus = 'ACTIVE' | 'DEGRADED';
export type ExcerptSourceState = 'ACTIVE' | 'SOURCE_MISSING' | 'REVOKED';
export type ActivityAction = 'CREATED' | 'UPDATED' | 'DELETED' | 'RESTORED' | 'STATUS_CHANGED' | 'COMPLETED';
export type ActivityEntityType =
  | 'BOOK'
  | 'DOG_EAR'
  | 'ANNOTATION'
  | 'REREAD_MARK'
  | 'COMPLETION_REFLECTION'
  | 'EXCERPT_CARD'
  | 'EXCERPT_SOURCE';
export declare const BOOK_STATUSES: BookStatus[];
export declare const MOOD_TAGS: MoodTag[];
export declare const TRACE_TYPES: TraceType[];
export declare const EXCERPT_CARD_STATUSES: ExcerptCardStatus[];
export declare const EXCERPT_SOURCE_STATES: ExcerptSourceState[];
export declare const ACTIVITY_ACTIONS: ActivityAction[];
export declare const ACTIVITY_ENTITY_TYPES: ActivityEntityType[];
