export interface TransferProgress {
  direction: "send" | "receive";
  transferred: number;
  total: number;
}
