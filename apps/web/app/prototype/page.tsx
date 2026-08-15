import { MoldingSurface } from './MoldingSurface';
import styles from './prototype.module.css';

/* One area, no chrome around it. `data-frame` switches the app into its mono
   register (globals.css scopes the typeface to it). Everything the prototype is
   trying to say happens inside MoldingSurface — this file only gives it a
   full-bleed ground to live on. */
export default function PrototypePage() {
  return (
    <div className={styles.ground} data-frame="atrium">
      <MoldingSurface />
    </div>
  );
}
