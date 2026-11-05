package net.stowapp.android;

import android.content.Context;
import android.os.SystemClock;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.work.*;
import java.util.concurrent.TimeUnit;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class SchedulerTest {
    @Test public void registeringTheNewPolicyRetiresOldHoursLongDelaysAndIsIdempotent() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        WorkManager work = WorkManager.getInstance(context);
        var prefs = context.getSharedPreferences("device", Context.MODE_PRIVATE);
        work.cancelAllWork().getResult().get();
        prefs.edit().clear().putString("account", "{}").putString("token", "test").commit();
        try {
            PeriodicWorkRequest old = new PeriodicWorkRequest.Builder(RefreshWorker.class, 15, TimeUnit.MINUTES).setInitialDelay(4, TimeUnit.HOURS).build();
            work.enqueueUniquePeriodicWork("stow-periodic-refresh", ExistingPeriodicWorkPolicy.KEEP, old).getResult().get();
            OneTimeWorkRequest oldNetwork = new OneTimeWorkRequest.Builder(RefreshWorker.class).setInitialDelay(4, TimeUnit.HOURS).build();
            work.enqueueUniqueWork("stow-opportunistic-refresh", ExistingWorkPolicy.KEEP, oldNetwork).getResult().get();
            Scheduler.register(context);
            WorkInfo next = null;
            long deadline = SystemClock.elapsedRealtime() + 5000;
            while (SystemClock.elapsedRealtime() < deadline) {
                var infos = work.getWorkInfosForUniqueWork(Scheduler.PERIODIC).get();
                if (!infos.isEmpty()) { next = infos.get(0); break; }
                SystemClock.sleep(20);
            }
            assertNotNull(next);
            assertEquals(WorkInfo.State.CANCELLED, work.getWorkInfoById(old.getId()).get().getState());
            assertEquals(WorkInfo.State.CANCELLED, work.getWorkInfoById(oldNetwork.getId()).get().getState());
            assertEquals(0, next.getRunAttemptCount());
            // RUNNING uses Long.MAX_VALUE; queued work must not inherit four hours.
            if (next.getState() == WorkInfo.State.ENQUEUED) assertTrue(next.getNextScheduleTimeMillis() <= System.currentTimeMillis() + TimeUnit.MINUTES.toMillis(15));
            Scheduler.register(context);
            var again = work.getWorkInfosForUniqueWork(Scheduler.PERIODIC).get();
            assertEquals(1, again.size()); assertEquals(next.getId(), again.get(0).getId());
        } finally { work.cancelAllWork().getResult().get(); prefs.edit().clear().commit(); }
    }
}
