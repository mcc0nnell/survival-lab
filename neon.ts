import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  functions: {
    trader: {
      name: "Survival Lab Trader",
      source: "./functions/trader.js",
      env: {
        TRADER_WINDOW_MS: "18000",
        TRADER_SAMPLE_MS: "1000"
      }
    }
  },
  triggers: {
    "trader-every-minute": {
      type: "schedule",
      function: "trader",
      cron: "* * * * *",
      functionPath: "/",
      enabled: true
    }
  }
});
