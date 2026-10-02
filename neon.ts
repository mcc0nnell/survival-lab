import { defineConfig } from "@neon/config/v1";

const survivalDatabaseUrl=process.env.SURVIVAL_DATABASE_URL;
if(!survivalDatabaseUrl){
  throw new Error("SURVIVAL_DATABASE_URL must target the survival_lab database");
}

export default defineConfig({
  functions: {
    trader: {
      name: "Survival Lab Trader",
      source: "./functions/trader.js",
      env: {
        DATABASE_URL: survivalDatabaseUrl,
        TRADER_WINDOW_MS: "55000",
        TRADER_SAMPLE_MS: "1000"
      }
    }
  },
  triggers: {}
});
