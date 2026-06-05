export function createBuildRunId(date = new Date()): string {
  return createTimestampId(date)
}

export function createTimestampId(date = new Date()): string {
  const year = date.getFullYear()
  const month = pad(date.getMonth() + 1)
  const day = pad(date.getDate())
  const hour = pad(date.getHours())
  const minute = pad(date.getMinutes())
  const second = pad(date.getSeconds())
  return `${year}${month}${day}-${hour}${minute}${second}`
}

export function createBuildTagName(runId: string, index: number): string {
  if (!Number.isInteger(index) || index < 1) throw new Error("tag index must be a positive integer")
  return `openralph/build-${runId}/${String(index).padStart(3, "0")}`
}

function pad(value: number): string {
  return String(value).padStart(2, "0")
}
