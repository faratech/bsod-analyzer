# AdSense Implementation Reference

This file contains all AdSense ad unit codes for the BSOD Analyzer project.

## Client ID
- **Publisher ID**: ca-pub-7455498979488414

## Ad Units

### 1. WindowsForum Responsive (Display Ad)
**Slot ID**: 6778196821  
**Format**: auto, full-width-responsive

```html
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-7455498979488414"
     crossorigin="anonymous"></script>
<!-- WindowsForum Responsive -->
<ins class="adsbygoogle"
     style="display:block"
     data-ad-client="ca-pub-7455498979488414"
     data-ad-slot="6778196821"
     data-ad-format="auto"
     data-full-width-responsive="true"></ins>
<script>
     (adsbygoogle = window.adsbygoogle || []).push({});
</script>
```

### 2. In-Article Format
**Slot ID**: 5939698092  
**Format**: fluid, in-article layout

```html
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-7455498979488414"
     crossorigin="anonymous"></script>
<ins class="adsbygoogle"
     style="display:block; text-align:center;"
     data-ad-layout="in-article"
     data-ad-format="fluid"
     data-ad-client="ca-pub-7455498979488414"
     data-ad-slot="5939698092"></ins>
<script>
     (adsbygoogle = window.adsbygoogle || []).push({});
</script>
```

### 3. Autorelaxed Format (Multiplex)
**Slot ID**: 5526116193  
**Format**: autorelaxed

```html
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-7455498979488414"
     crossorigin="anonymous"></script>
<ins class="adsbygoogle"
     style="display:block"
     data-ad-format="autorelaxed"
     data-ad-client="ca-pub-7455498979488414"
     data-ad-slot="5526116193"></ins>
<script>
     (adsbygoogle = window.adsbygoogle || []).push({});
</script>
```

### 4. Square Responsive
**Slot ID**: 5987799550  
**Format**: auto, full-width-responsive

```html
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-7455498979488414"
     crossorigin="anonymous"></script>
<!-- Square Responsive -->
<ins class="adsbygoogle"
     style="display:block"
     data-ad-client="ca-pub-7455498979488414"
     data-ad-slot="5987799550"
     data-ad-format="auto"
     data-full-width-responsive="true"></ins>
<script>
     (adsbygoogle = window.adsbygoogle || []).push({});
</script>
```

**AMP Version:**
```html
<amp-ad width="100vw" height="320"
     type="adsense"
     data-ad-client="ca-pub-7455498979488414"
     data-ad-slot="5987799550"
     data-auto-format="rspv"
     data-full-width="">
  <div overflow=""></div>
</amp-ad>
```

### 5. Horizontal Responsive
**Slot ID**: 2048554545  
**Format**: auto, full-width-responsive

```html
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-7455498979488414"
     crossorigin="anonymous"></script>
<!-- Horizontal Responsive -->
<ins class="adsbygoogle"
     style="display:block"
     data-ad-client="ca-pub-7455498979488414"
     data-ad-slot="2048554545"
     data-ad-format="auto"
     data-full-width-responsive="true"></ins>
<script>
     (adsbygoogle = window.adsbygoogle || []).push({});
</script>
```

**AMP Version:**
```html
<amp-ad width="100vw" height="320"
     type="adsense"
     data-ad-client="ca-pub-7455498979488414"
     data-ad-slot="2048554545"
     data-auto-format="rspv"
     data-full-width="">
  <div overflow=""></div>
</amp-ad>
```

### 6. Vertical Responsive
**Slot ID**: 8366550888  
**Format**: auto, full-width-responsive

```html
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-7455498979488414"
     crossorigin="anonymous"></script>
<!-- Vertical Responsive -->
<ins class="adsbygoogle"
     style="display:block"
     data-ad-client="ca-pub-7455498979488414"
     data-ad-slot="8366550888"
     data-ad-format="auto"
     data-full-width-responsive="true"></ins>
<script>
     (adsbygoogle = window.adsbygoogle || []).push({});
</script>
```

**AMP Version:**
```html
<amp-ad width="100vw" height="320"
     type="adsense"
     data-ad-client="ca-pub-7455498979488414"
     data-ad-slot="8366550888"
     data-auto-format="rspv"
     data-full-width="">
  <div overflow=""></div>
</amp-ad>
```

### 7. Vertical Responsive Multiplex
**Slot ID**: 1275879997  
**Format**: autorelaxed

```html
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-7455498979488414"
     crossorigin="anonymous"></script>
<ins class="adsbygoogle"
     style="display:block"
     data-ad-format="autorelaxed"
     data-ad-client="ca-pub-7455498979488414"
     data-ad-slot="1275879997"></ins>
<script>
     (adsbygoogle = window.adsbygoogle || []).push({});
</script>
```

**AMP Version:**
```html
<amp-ad width="100vw" height="320"
     type="adsense"
     data-ad-client="ca-pub-7455498979488414"
     data-ad-slot="1275879997"
     data-auto-format="mcrspv"
     data-full-width="">
  <div overflow=""></div>
</amp-ad>
```

## Best Practices

### Ad Placement Guidelines
Reference: https://support.google.com/adsense/answer/7533385?hl=en

1. **Above the fold**: Place at least one ad unit above the fold
2. **In-content ads**: Place ads between paragraphs for better engagement
3. **Sidebar ads**: Use vertical responsive formats for sidebars
4. **Mobile optimization**: Ensure ads are responsive for mobile devices
5. **Ad density**: Follow Google's ad density guidelines (no more than 30% of content)

### Implementation Notes

1. **Script Loading**: The AdSense script only needs to be loaded once per page
2. **Push Method**: Call `(adsbygoogle = window.adsbygoogle || []).push({})` for each ad unit
3. **AMP Ads**: Use specific AMP ad components with proper data attributes
4. **Responsive Formats**: 
   - `rspv` = Responsive 
   - `mcrspv` = Multiplex responsive
5. **Testing**: Use `data-adtest="on"` attribute during development

### Ad Types Summary

- **Display Ads**: WindowsForum Responsive, Square, Horizontal, Vertical
- **In-Article Ads**: For content integration
- **Multiplex Ads**: For content recommendations (autorelaxed, vertical multiplex)
- **AMP Ads**: Special format for AMP pages with overflow div