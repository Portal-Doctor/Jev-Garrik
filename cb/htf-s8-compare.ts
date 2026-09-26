import { compareThirtyDayOldVsNew } from "./backtest";

const result = await compareThirtyDayOldVsNew();
console.log(JSON.stringify(result, null, 2));
