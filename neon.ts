import { defineConfig } from "@neon/config/v1";

const survivalDatabaseUrl=process.env.SURVIVAL_DATABASE_URL;
const traderControlToken=process.env.TRADER_CONTROL_TOKEN;
if(!survivalDatabaseUrl){
  throw new Error("SURVIVAL_DATABASE_URL must target the survival_lab database");
}
if(!traderControlToken){
  throw new Error("TRADER_CONTROL_TOKEN is required for bounded session invocations");
}

export default defineConfig({
  functions: {
    trader: {
      name: "Survival Lab Trader",
      source: "./functions/trader.js",
      env: {
        DATABASE_URL: survivalDatabaseUrl,
        TRADER_CONTROL_TOKEN: traderControlToken,
        TRADER_WINDOW_MS: "55000",
        TRADER_SAMPLE_MS: "1000"
      }
    }
  },
  triggers: {}
});
