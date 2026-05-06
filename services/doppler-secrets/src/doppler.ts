import { DopplerUnavailableError } from "./types.js";

export async function fetchDopplerSecrets(
  serviceToken: string,
  project: string,
  config: string
): Promise<Record<string, string>> {
  const url = new URL(
    "https://api.doppler.com/v3/configs/config/secrets/download"
  );
  url.searchParams.set("format", "json");
  url.searchParams.set("project", project);
  url.searchParams.set("config", config);
  url.searchParams.set("include_dynamic_secrets", "false");

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${serviceToken}`,
        Accept: "application/json",
      },
    });
  } catch (err) {
    throw new DopplerUnavailableError(
      "Network error contacting Doppler API",
      err
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "(unreadable body)");
    throw new DopplerUnavailableError(
      `Doppler API returned ${response.status}: ${body}`
    );
  }

  return (await response.json()) as Record<string, string>;
}
