import { Sidebar } from "@/components/sidebar";
import { Onboarding } from "@/components/onboarding";
import { CommandPalette } from "@/components/command-palette";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <Onboarding />
      <CommandPalette />
      <Sidebar />
      <main className="md:ml-64 min-h-screen">
        <div className="p-6 md:p-8">{children}</div>
      </main>
    </div>
  );
}
