/**
 * Core data structures for the settlement schedule reflow system.
 * Mirrors the document shape used across the platform: { docId, docType, data }.
 */

interface Document<TDocType extends string, TData> {
  docId: string;
  docType: TDocType;
  data: TData;
}

export type TaskType =
  | "marginCheck"
  | "fundTransfer"
  | "disbursement"
  | "complianceScreen"
  | "reconciliation"
  | "regulatoryHold";

export interface SettlementTaskData {
  taskReference: string;
  tradeOrderId: string;
  settlementChannelId: string;

  // Timing — all dates are ISO 8601 strings in UTC.
  startDate: string;
  endDate: string;
  durationMinutes: number;

  // Constraints
  isRegulatoryHold: boolean;

  // Dependencies — all referenced tasks must complete before this one starts.
  dependsOnTaskIds: string[];

  taskType: TaskType;
}

export type SettlementTask = Document<"settlementTask", SettlementTaskData>;

export interface OperatingHoursWindow {
  dayOfWeek: number; // 0-6, Sunday = 0. Interpreted in UTC.
  startHour: number; // 0-23, UTC
  endHour: number; // 0-23, UTC
}

export interface BlackoutWindow {
  startDate: string; // ISO 8601, UTC
  endDate: string; // ISO 8601, UTC
  reason?: string;
}

export interface SettlementChannelData {
  name: string;
  operatingHours: OperatingHoursWindow[];
  blackoutWindows: BlackoutWindow[];
}

export type SettlementChannel = Document<"settlementChannel", SettlementChannelData>;

export interface TradeOrderData {
  tradeOrderNumber: string;
  instrumentId: string;
  quantity: number;
  settlementDate: string; // ISO 8601 target settlement date (T+1, T+2, etc.)
}

export type TradeOrder = Document<"tradeOrder", TradeOrderData>;

/** Input to the reflow algorithm. */
export interface ReflowInput {
  settlementTasks: SettlementTask[];
  settlementChannels: SettlementChannel[];
  tradeOrders: TradeOrder[];
}

/** A single task's before/after, with the reason it moved. */
export interface ScheduleChange {
  taskId: string;
  taskReference: string;
  originalStartDate: string;
  originalEndDate: string;
  newStartDate: string;
  newEndDate: string;
  deltaMinutes: number;
  reason: string;
}

/** Output of the reflow algorithm. */
export interface ReflowResult {
  updatedTasks: SettlementTask[];
  changes: ScheduleChange[];
  explanation: string[];
}
