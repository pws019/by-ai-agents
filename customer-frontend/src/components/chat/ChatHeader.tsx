export function ChatHeader({ title }: { title: string }) {
  return (
    <header className="flex justify-between items-center h-16 px-gutter border-b border-outline-variant bg-surface shrink-0">
      <h2 className="text-headline-sm font-semibold text-on-surface truncate">{title}</h2>
    </header>
  );
}
