import { defineConfig } from "@neon/config/v1";

const survivalDatabaseUrl=process.env.SURVIVAL_DATABASE_URL;
const coinbaseApiKey=process.env.COINBASE_API_KEY;
const coinbaseApiSecret=process.env.COINBASE_API_SECRET;
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
        TRADER_SAMPLE_MS: "1000",
        ...(coinbaseApiKey&&coinbaseApiSecret?{
          COINBASE_API_KEY:coinbaseApiKey,
          COINBASE_API_SECRET:coinbaseApiSecret
        }:{})
      }
    }
  },
  triggers: {}
});
