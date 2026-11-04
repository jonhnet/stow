package net.stowapp.android;

import android.content.pm.PackageManager;
import java.io.File;
import java.util.Arrays;

final class ApkVerifier {
    static void verify(PackageManager manager, String packageName, File file, long version) throws Exception {
        var candidate = manager.getPackageArchiveInfo(file.getPath(), PackageManager.GET_SIGNING_CERTIFICATES);
        var installed = manager.getPackageInfo(packageName, PackageManager.GET_SIGNING_CERTIFICATES);
        if (candidate == null || !packageName.equals(candidate.packageName) || candidate.getLongVersionCode() != version ||
            candidate.signingInfo == null || !Arrays.equals(candidate.signingInfo.getApkContentsSigners(), installed.signingInfo.getApkContentsSigners()))
            throw new Exception("Android update has the wrong package, version, or signing identity");
    }
}
