/**
 * Recalculate the PDF economics from the exact saved inputs.
 * Storage contract: reviewRate is always a percentage (0..100), while
 * errorRate is stored as a fraction (0..1). For legacy records, errorRate
 * values above 1 and up to 100 are accepted as percentage values.
 */
export function recalculateSavedEconomics(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Saved economics data is missing." };
  }

  const read = (key) => {
    const value = input[key];
    if (value === null || value === undefined || value === "") return NaN;
    return Number(value);
  };
  const required = ["tasks", "mins", "labor", "ai", "review", "reviewRate", "errorRate"];
  const values = Object.fromEntries(required.map((key) => [key, read(key)]));
  if (required.some((key) => !Number.isFinite(values[key]))) {
    return {
      ok: false,
      error: "This saved report is missing one or more required economics inputs. Open the report, complete its economics assumptions, save it again, and retry the PDF export."
    };
  }

  const { tasks, mins, labor, ai, review } = values;
  const reviewRatePct = values.reviewRate;
  const errorRateRaw = values.errorRate;
  if (tasks <= 0 || mins <= 0 || labor < 0 || ai < 0 || review < 0 || reviewRatePct < 0 || reviewRatePct > 100 || errorRateRaw < 0 || errorRateRaw > 100) {
    return { ok: false, error: "This saved report contains economics inputs outside the supported ranges. Review the assumptions, save the report again, and retry the PDF export." };
  }

  const reviewRate = reviewRatePct / 100;
  const errorRate = errorRateRaw > 1 ? errorRateRaw / 100 : errorRateRaw;
  const current = tasks * mins / 60 * labor;
  const automation = tasks * ai + tasks * reviewRate * review / 60 * labor;
  // Six minutes of human correction per AI error = 0.1 labor hours.
  const correction = tasks * errorRate * labor * 0.1;
  const saving = Math.max(0, current - automation - correction);
  const setup = read("setup");
  const payback = Number.isFinite(setup) && setup > 0 && saving > 0 ? setup / saving : null;

  return {
    ok: true,
    economics: {
      ...input,
      current,
      automation,
      saving,
      payback,
      errorRate,
      // Keep this in the same 0..100 percentage unit used by the UI.
      reviewRate: reviewRatePct
    }
  };
}
