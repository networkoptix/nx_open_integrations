#!/usr/bin/env python3

## Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

import math
from enum import IntEnum
from dataclasses import dataclass
from pprint import pprint

import common.server_api as api

USERNAME = 'admin'  # local account username
PASSWORD = 'qweasd234'  # local account password
LOCAL_URL = 'https://localhost:7001'

HOURS_PER_DAY = 24
SECONDS_PER_HOUR = 3600

class DayOfWeek(IntEnum):
    MONDAY = 1
    TUESDAY = 2
    WEDNESDAY = 3
    THURSDAY = 4
    FRIDAY = 5
    SATURDAY = 6
    SUNDAY = 7

@dataclass
class ScheduleTask:
    dayOfWeek: DayOfWeek
    startTime: int  # Seconds since 00:00, value in range [0..endTime]
    endTime: int  # Seconds since 00:00, value in range [startTime..86400]

def createEmptyTable():
    table = []
    for day in range(len(DayOfWeek)):  # stream representation of each day
        table.append([False] * HOURS_PER_DAY)
    return table

# Serialize list of schedule tasks into bit represenation. Note: schedule resolution is 1 hour,
# so part of the hour is repesented as a full hour.
def serialize(tasks: list[ScheduleTask]) -> str:
    table = createEmptyTable()

    for task in tasks:
        index: int = task.dayOfWeek - 1 # index in table
        startHour: int = max(math.floor(task.startTime / 3600), 0)
        endHour: int = min(math.ceil(task.endTime / 3600), HOURS_PER_DAY) # 1 second rounds up to 1 hour
        for hour in range(startHour, endHour):
            table[index][hour] = True

    bitStream: str = ""
    for day in table:
        for hour in day:
            bitStream += "1" if hour else "0"
    value = int(bitStream, 2)
    return str(hex(value))[2:] # skip 0x in the beginning


def deserialize(stream: str) -> list[ScheduleTask]:
    result: list[ScheduleTask] = []

    if not stream:
        stream = "f" * 6 * len(DayOfWeek) # 6 symbols per day
    stream = stream.replace(" ", "")
    bitStream = bin(int(stream, 16))[2:]
    assert(len(bitStream) == HOURS_PER_DAY * len(DayOfWeek))

    for day in range(len(DayOfWeek)):  # stream representation of each day
        task = None
        indent = HOURS_PER_DAY * day
        for hour in range(0, HOURS_PER_DAY):
            is_recording: bool = bitStream[indent + hour] == "1"
            seconds_since_midnight: int = hour * SECONDS_PER_HOUR
            if is_recording and not task:
                task = ScheduleTask(day + 1, seconds_since_midnight, 0)
            elif task and not is_recording:
                task.endTime = seconds_since_midnight
                result.append(task)
                task = None
        if task:
           task.endTime =  SECONDS_PER_HOUR * HOURS_PER_DAY
           result.append(task)
    return result


# Example function which modifies schedule of some rules based on their comment.
def modifyRuleIfNeeded(session, rule):
    if rule['comment'] == 'Weekdays':
        schedule = [task for task in deserialize(rule['schedule']) if task.dayOfWeek < DayOfWeek.SATURDAY]
        rule['schedule'] = serialize(schedule)
        session.post('/ec2/saveEventRule', json=rule)

    if rule['comment'] == 'Weekend':
        schedule = [task for task in deserialize(rule['schedule']) if task.dayOfWeek > DayOfWeek.FRIDAY]
        rule['schedule'] = serialize(schedule)
        session.post('/ec2/saveEventRule', json=rule)

def main():
    session = api.Session(LOCAL_URL, USERNAME, PASSWORD)
    try:
        rules = session.get('/ec2/getEventRules')
        for rule in rules:
            modifyRuleIfNeeded(session, rule)
    except api.Session.RequestException as e:
        print(e)


if __name__ == '__main__':
    main()
