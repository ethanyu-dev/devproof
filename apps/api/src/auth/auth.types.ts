export interface AuthContext {
  sessionId: string;
  team: {
    id: string;
    name: string;
    slug: string;
  };
  user: {
    avatarUrl: string | null;
    email: string | null;
    id: string;
    name: string | null;
  };
}
