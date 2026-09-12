import { auth } from "@/auth";

export async function isAdministrator() {
  const session = await auth();
  return Boolean(session?.user);
}

export async function requireAdministrator() {
  if (!(await isAdministrator())) throw new Error("UNAUTHORIZED");
}
