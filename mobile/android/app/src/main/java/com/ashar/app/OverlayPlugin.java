package com.ashar.app;

import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * أسهَر floating overlay — a single speed/alert bubble drawn over other apps
 * (incl. Google Maps) via SYSTEM_ALERT_WINDOW.
 *
 * Everything is static so the bubble is ONE per process: reopening the app
 * (which keeps running via the location foreground service) reuses the same
 * view instead of stacking duplicates. It's removed when the activity is
 * destroyed (app closed) and by a tap on the bubble itself.
 */
@CapacitorPlugin(name = "Overlay")
public class OverlayPlugin extends Plugin {
    private static WindowManager wm;
    private static View bubble;
    private static TextView speedTv, infoTv;
    private static GradientDrawable bg;
    private static WindowManager.LayoutParams lp;
    private static boolean attached = false;
    private final Handler ui = new Handler(Looper.getMainLooper());

    private boolean canDraw() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.M
                || Settings.canDrawOverlays(getContext());
    }

    @PluginMethod
    public void hasPermission(PluginCall call) {
        JSObject r = new JSObject();
        r.put("granted", canDraw());
        call.resolve(r);
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        try {
            if (!canDraw() && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                Intent i = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        Uri.parse("package:" + getContext().getPackageName()));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
            }
        } catch (Exception ignored) {}
        JSObject r = new JSObject();
        r.put("granted", canDraw());
        call.resolve(r);
    }

    @PluginMethod
    public void show(final PluginCall call) {
        ui.post(() -> {
            try {
                if (!canDraw()) { call.reject("no_overlay_permission"); return; }
                if (bubble == null) build();
                if (!attached || bubble.getParent() == null) {
                    if (bubble.getParent() != null) { try { wm.removeView(bubble); } catch (Exception ignored) {} }
                    wm.addView(bubble, lp);
                    attached = true;
                }
                bubble.setVisibility(View.VISIBLE);
                call.resolve();
            } catch (Exception e) { call.reject(String.valueOf(e.getMessage())); }
        });
    }

    @PluginMethod
    public void update(final PluginCall call) {
        final String speed = call.getString("speed", "0");
        final String info = call.getString("info", "");
        final String state = call.getString("state", "normal");
        ui.post(() -> {
            try {
                if (speedTv != null) {
                    speedTv.setText(speed);
                    infoTv.setText(info);
                    int c = "over".equals(state) ? Color.parseColor("#ff3b30")
                            : "warn".equals(state) ? Color.parseColor("#ffd47e")
                            : Color.parseColor("#e8edf2");
                    speedTv.setTextColor(c);
                    bg.setStroke(dp(2), "over".equals(state)
                            ? Color.parseColor("#ff3b30") : Color.parseColor("#40ffffff"));
                }
            } catch (Exception ignored) {}
            call.resolve();
        });
    }

    @PluginMethod
    public void hide(final PluginCall call) {
        ui.post(() -> { removeBubble(); call.resolve(); });
    }

    private static void removeBubble() {
        try { if (wm != null && bubble != null && bubble.getParent() != null) wm.removeView(bubble); }
        catch (Exception ignored) {}
        attached = false;
    }

    @Override
    protected void handleOnDestroy() {
        // app closed → take the bubble down with it
        ui.post(OverlayPlugin::removeBubble);
        super.handleOnDestroy();
    }

    private void build() {
        Context ctx = getContext().getApplicationContext();
        wm = (WindowManager) ctx.getSystemService(Context.WINDOW_SERVICE);

        LinearLayout box = new LinearLayout(ctx);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setPadding(dp(16), dp(10), dp(16), dp(10));
        bg = new GradientDrawable();
        bg.setColor(Color.parseColor("#ee0d131b"));
        bg.setCornerRadius(dp(20));
        bg.setStroke(dp(2), Color.parseColor("#40ffffff"));
        box.setBackground(bg);

        speedTv = new TextView(ctx);
        speedTv.setText("0");
        speedTv.setTextSize(32);
        speedTv.setTypeface(speedTv.getTypeface(), Typeface.BOLD);
        speedTv.setTextColor(Color.parseColor("#e8edf2"));
        speedTv.setGravity(Gravity.CENTER);
        box.addView(speedTv);

        infoTv = new TextView(ctx);
        infoTv.setText("أسهَر · المس للإخفاء");
        infoTv.setTextSize(10);
        infoTv.setTextColor(Color.parseColor("#8b97a3"));
        infoTv.setGravity(Gravity.CENTER);
        box.addView(infoTv);

        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;
        lp = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.WRAP_CONTENT,
                type,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP | Gravity.START;
        lp.x = dp(16);
        lp.y = dp(120);

        // drag to move; a tap (no drag) hides the bubble
        box.setOnTouchListener(new View.OnTouchListener() {
            float ix, iy; int ox, oy; boolean moved;
            @Override public boolean onTouch(View v, MotionEvent e) {
                switch (e.getAction()) {
                    case MotionEvent.ACTION_DOWN:
                        ix = e.getRawX(); iy = e.getRawY(); ox = lp.x; oy = lp.y; moved = false;
                        return true;
                    case MotionEvent.ACTION_MOVE:
                        int dx = (int) (e.getRawX() - ix), dy = (int) (e.getRawY() - iy);
                        if (Math.abs(dx) > dp(6) || Math.abs(dy) > dp(6)) moved = true;
                        lp.x = ox + dx; lp.y = oy + dy;
                        try { wm.updateViewLayout(bubble, lp); } catch (Exception ignored) {}
                        return true;
                    case MotionEvent.ACTION_UP:
                        if (!moved) removeBubble(); // tap → dismiss
                        return true;
                }
                return false;
            }
        });
        bubble = box;
    }

    private int dp(int v) {
        return (int) (v * getContext().getResources().getDisplayMetrics().density);
    }
}
