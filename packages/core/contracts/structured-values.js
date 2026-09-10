export function parseJsonObject(value, label) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${label} must be a JSON object`);
    }
    return parsed;
  } catch (error) {
    if (error.message.includes(label)) {
      throw error;
    }
    throw new Error(`${label} must be valid JSON: ${error.message}`);
  }
}

export function parseJsonArray(value, label) {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      throw new Error(`${label} must be a JSON array`);
    }
    return parsed;
  } catch (error) {
    if (error.message.includes(label)) {
      throw error;
    }
    throw new Error(`${label} must be valid JSON: ${error.message}`);
  }
}
