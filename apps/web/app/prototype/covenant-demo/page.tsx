import styles from '../prototype.module.css';
import { CovenantDemo } from './CovenantDemo';

/* The drivable covenant demo (#212), a route of its own so the existing
   `/prototype` design surface is untouched. Full-bleed mono ground, like the
   sibling route; the demo itself is a client component. */
export default function CovenantDemoPage() {
  return (
    <div className={styles.ground} data-frame="atrium">
      <CovenantDemo />
    </div>
  );
}
