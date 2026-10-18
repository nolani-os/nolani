// Custom Matrix account-data event types used by the Teams app. matrix-js-sdk
// (>= 42) only accepts account-data types it knows about; this augmentation
// declares ours and their content shape.
import type { CustomTab } from "./customTabs";

declare module "matrix-js-sdk/lib/@types/event" {
  interface RoomAccountDataEvents {
    /** Custom channel tabs, stored per room (see customTabs.ts). */
    "io.claraos.teams.custom_tabs": { tabs: CustomTab[] };
  }
}
