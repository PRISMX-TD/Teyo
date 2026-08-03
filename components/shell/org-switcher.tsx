'use client';

import { useRouter } from 'next/navigation';

type Org = {
  id: string;
  slug: string;
  name: string;
};

type Props = {
  current: string;
  orgs: Org[];
};

export function OrgSwitcher({ current, orgs }: Props) {
  const router = useRouter();

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const slug = e.target.value;
    if (slug && slug !== current) {
      router.push(`/${slug}`);
    }
  }

  if (orgs.length <= 1) return null;

  return (
    <div className="org-switcher">
      <select defaultValue={current} onChange={handleChange}>
        {orgs.map((org) => (
          <option key={org.id} value={org.slug}>
            {org.name}
          </option>
        ))}
      </select>
    </div>
  );
}
