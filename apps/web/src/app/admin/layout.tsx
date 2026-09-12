import { redirect } from "next/navigation";

import { auth } from "@/auth";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  return <div className="min-h-screen bg-[#f8f8f6]">{children}</div>;
}
