import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";

export const { auth, handlers, signIn, signOut } = NextAuth({
  providers: [GitHub],
  callbacks: {
    signIn({ profile }) {
      const administratorId = process.env.ADMIN_GITHUB_ID;
      return Boolean(administratorId && profile?.id && String(profile.id) === administratorId);
    },
    authorized({ auth: session }) {
      return Boolean(session?.user);
    },
  },
  pages: { signIn: "/login" },
});
