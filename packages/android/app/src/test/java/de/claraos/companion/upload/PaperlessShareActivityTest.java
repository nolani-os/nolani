package de.claraos.companion.upload;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class PaperlessShareActivityTest {
    private static final String PKG = "de.nolanios.companion";

    @Test
    public void onlyForeignContentIsShared() {
        assertTrue(PaperlessShareActivity.isSharedContent("content", "com.android.providers.media.documents", PKG));
        assertFalse(PaperlessShareActivity.isSharedContent("file", null, PKG));
        assertFalse(PaperlessShareActivity.isSharedContent("content", PKG + ".fileprovider", PKG));
        assertFalse(PaperlessShareActivity.isSharedContent("content", PKG, PKG));
        assertFalse(PaperlessShareActivity.isSharedContent("content", null, PKG));
    }
}
