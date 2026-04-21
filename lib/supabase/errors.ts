const SUPABASE_SCHEMA_SETUP_MESSAGE =
  "Supabase schema is not installed yet. Run supabase/schema.sql in your Supabase project, then refresh.";

function extractErrorParts(error: unknown) {
  if (!error || typeof error !== "object") {
    return {
      message: "",
      code: ""
    };
  }

  const value = error as {
    message?: unknown;
    code?: unknown;
  };

  return {
    message: typeof value.message === "string" ? value.message : "",
    code: typeof value.code === "string" ? value.code : ""
  };
}

export function isSupabaseSchemaMissingError(error: unknown) {
  const { message, code } = extractErrorParts(error);
  return (
    message === SUPABASE_SCHEMA_SETUP_MESSAGE ||
    code === "PGRST205" ||
    code === "42P01" ||
    /schema cache/i.test(message) ||
    /relation .* does not exist/i.test(message)
  );
}

export function normalizeSupabaseError(error: unknown) {
  if (isSupabaseSchemaMissingError(error)) {
    return new Error(SUPABASE_SCHEMA_SETUP_MESSAGE);
  }

  const { message } = extractErrorParts(error);
  if (message) {
    return new Error(message);
  }

  return error instanceof Error ? error : new Error("Supabase request failed.");
}

export function getSupabaseSchemaSetupMessage() {
  return SUPABASE_SCHEMA_SETUP_MESSAGE;
}
