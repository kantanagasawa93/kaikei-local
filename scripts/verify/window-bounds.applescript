-- KAIKEI LOCAL の最前面ウィンドウの bounds を「X Y W H」(スペース区切り) で出力
-- (アプリ名は引数で受け取り。例: "KAIKEI LOCAL")
on run argv
    set appName to "KAIKEI LOCAL"
    if (count of argv) > 0 then
        set appName to item 1 of argv
    end if
    try
        tell application "System Events"
            tell process appName
                set frontWin to front window
                set p to position of frontWin
                set s to size of frontWin
                set xVal to (item 1 of p) as integer
                set yVal to (item 2 of p) as integer
                set wVal to (item 1 of s) as integer
                set hVal to (item 2 of s) as integer
                return (xVal as string) & " " & (yVal as string) & " " & (wVal as string) & " " & (hVal as string)
            end tell
        end tell
    on error errMsg
        -- 取れなかったら空 → 呼出側が「全画面 fallback」する
        return ""
    end try
end run
