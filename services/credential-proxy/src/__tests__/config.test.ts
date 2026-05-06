import { describe, it, expect } from "vitest";
import {
  CREDENTIAL_PROXY_PORT_ENV,
  CREDENTIAL_PROXY_URL_ENV,
  DOPPLER_SERVICE_TOKEN_ENV,
  DOPPLER_TOKEN_ENV,
  DOPPLER_PROJECT_ENV,
  DOPPLER_CONFIG_ENV,
  SUPABASE_URL_ENV,
  SUPABASE_SERVICE_KEY_ENV,
  DEFAULT_PORT,
} from "../config.js";

describe("credential-proxy config constants", () => {
  it("env var name constants match expected strings", () => {
    expect(CREDENTIAL_PROXY_PORT_ENV).toBe("CREDENTIAL_PROXY_PORT");
    expect(CREDENTIAL_PROXY_URL_ENV).toBe("CREDENTIAL_PROXY_URL");
    expect(DOPPLER_SERVICE_TOKEN_ENV).toBe("DOPPLER_SERVICE_TOKEN");
    expect(DOPPLER_TOKEN_ENV).toBe("DOPPLER_TOKEN");
    expect(DOPPLER_PROJECT_ENV).toBe("DOPPLER_PROJECT");
    expect(DOPPLER_CONFIG_ENV).toBe("DOPPLER_CONFIG");
    expect(SUPABASE_URL_ENV).toBe("SUPABASE_URL");
    expect(SUPABASE_SERVICE_KEY_ENV).toBe("SUPABASE_SERVICE_KEY");
  });

  it("default value constants are correct", () => {
    expect(DEFAULT_PORT).toBe(7447);
  });
});
