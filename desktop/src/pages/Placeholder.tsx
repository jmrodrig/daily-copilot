import PageHeader from "../components/PageHeader";

export default function Placeholder({ title }: { title: string }) {
  return (
    <div className="flex flex-col gap-5 px-9 py-7">
      <PageHeader title={title} subtitle="Coming soon." />
    </div>
  );
}
