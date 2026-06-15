package com.ashar.app;

import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.PixelFormat;
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
 * أسهَر floating overlay — a small speed/alert bubble drawn over other apps
 * (incl. Google Maps) via SYSTEM_ALERT_WINDOW. JS shows it when the app is
 * backgrounded during a trip and updates it on each location fix.
 */
@CapacitorPlugin(name = "Overlay")
public class OverlayPlugin extends Plugin {
    private WindowManager wm;
    private View bubble;
    private TextView speedTv, infoTv;
    private GradientDrawable bg;
    private WindowManager.LayoutParams lp;
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
                if (bubble.getParent() == null) wm.addView(bubble, lp);
                bubble.setVisibility(View.VISIBLE);
                call.resolve();
            } catch (Exception e) { call.reject(String.valueOf(e.getMessage())); }
        });
    }

    @PluginMethod
    public void update(final PluginCall call) {
        final String speed = call.getString("speed", "0");
        final String info = call.getString("info", "");
        final String state = call.getString("state", "normal"); // normal | warn | over
        ui.post(() -> {
            try {
                if (speedTv == null) { call.resolve(); return; }
                speedTv.setText(speed);
                infoTv.setText(info);
                int c = "over".equals(state) ? Color.parseColor("#ff3b30")
                        : "warn".equals(state) ? Color.parseColor("#ffd47e")
                        : Color.parseColor("#e8edf2");
                speedTv.setTextColor(c);
                bg.setStroke(dp(2), "over".equals(state)
                        ? Color.parseColor("#ff3b30") : Color.parseColor("#40ffffff"));
            } catch (Exception ignored) {}
            call.resolve();
        });
    }

    @PluginMethod
    public void hide(final PluginCall call) {
        ui.post(() -> {
            try { if (bubble != null && bubble.getParent() != null) wm.removeView(bubble); }
            catch (Exception ignored) {}
            call.resolve();
        });
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
        speedTv.setTypeface(speedTv.getTypeface(), android.graphics.Typeface.BOLD);
        speedTv.setTextColor(Color.parseColor("#e8edf2"));
        speedTv.setGravity(Gravity.CENTER);
        box.addView(speedTv);

        infoTv = new TextView(ctx);
        infoTv.setText("أسهَر");
        infoTv.setTextSize(11);
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

        // draggable so it can be moved off Google Maps' own controls
        box.setOnTouchListener(new View.OnTouchListener() {
            float ix, iy; int ox, oy;
            @Override public boolean onTouch(View v, MotionEvent e) {
                switch (e.getAction()) {
                    case MotionEvent.ACTION_DOWN:
                        ix = e.getRawX(); iy = e.getRawY(); ox = lp.x; oy = lp.y; return true;
                    case MotionEvent.ACTION_MOVE:
                        lp.x = ox + (int) (e.getRawX() - ix);
                        lp.y = oy + (int) (e.getRawY() - iy);
                        try { wm.updateViewLayout(bubble, lp); } catch (Exception ignored) {}
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
